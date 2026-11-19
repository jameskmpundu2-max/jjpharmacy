require('dotenv').config();
const express = require('express');
const http = require('http');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { timingSafeEqual } = require('node:crypto');
const { Server } = require('socket.io');
const { pool, initDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

const sessionMiddleware = session({
  store: new PgSession({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd || process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 10 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const clean = v => String(v ?? '').trim();
const num = v => Number(v);
const validInt = v => Number.isInteger(num(v)) && num(v) > 0;
const isAdmin = (req,res,next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
};
const auth = (req,res,next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in.' });
function emitStock(productId, details = {}) { io.emit('stock:changed', { productId, ...details }); }
function emitDashboard() { io.emit('dashboard:changed'); }
function receiptNo() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
  return `RC-${stamp}-${Math.floor(Math.random()*900+100)}`;
}

app.get('/api/config', (req,res) => res.json({
  pharmacyName: process.env.PHARMACY_NAME || 'My Pharmacy',
  address: process.env.PHARMACY_ADDRESS || 'Lusaka, Zambia',
  phone: process.env.PHARMACY_PHONE || '',
  currency: process.env.CURRENCY || 'ZMW'
}));
app.post('/api/auth/login', loginLimiter, asyncRoute(async (req,res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  const result = await pool.query('SELECT id,name,email,password_hash,role,active FROM users WHERE email=$1',[email]);
  const user = result.rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password,user.password_hash)))
    return res.status(401).json({ error: 'Invalid email or password.' });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: req.session.user });
}));
app.post('/api/auth/logout', auth, (req,res) => req.session.destroy(err => {
  if (err) return res.status(500).json({error:'Could not log out.'});
  res.clearCookie('connect.sid'); res.json({ok:true});
}));
app.get('/api/auth/me', (req,res) => res.json({ user: req.session.user || null }));

app.get('/api/dashboard', auth, asyncRoute(async (req,res) => {
  const [p,s,t,low,lowItems,exp,recent,salesPeriods] = await Promise.all([
    pool.query('SELECT COUNT(*)::int products, COALESCE(SUM(quantity),0)::int units FROM products WHERE active=true'),
    pool.query("SELECT COUNT(*)::int count, COALESCE(SUM(total),0)::numeric total FROM sales WHERE sale_date::date=CURRENT_DATE"),
    pool.query("SELECT COUNT(*)::int count FROM purchases WHERE purchase_date=CURRENT_DATE"),
    pool.query('SELECT COUNT(*)::int count FROM products WHERE active=true AND quantity<=reorder_level'),
    pool.query('SELECT id,name,sku,quantity,reorder_level FROM products WHERE active=true AND quantity<=reorder_level ORDER BY quantity ASC,name LIMIT 50'),
    pool.query("SELECT COUNT(*)::int count FROM products WHERE active=true AND expiry_date IS NOT NULL AND expiry_date<=CURRENT_DATE+INTERVAL '30 days'"),
    pool.query(`SELECT sm.id,sm.movement_type,sm.quantity_change,sm.balance_after,sm.reference,sm.created_at,p.name
      FROM stock_movements sm JOIN products p ON p.id=sm.product_id ORDER BY sm.created_at DESC LIMIT 8`),
    pool.query(`SELECT
      COUNT(*) FILTER (WHERE sale_date::date=CURRENT_DATE)::int day_count,
      COALESCE(SUM(total) FILTER (WHERE sale_date::date=CURRENT_DATE),0)::numeric day_total,
      COUNT(*) FILTER (WHERE sale_date::date>=date_trunc('week',CURRENT_DATE)::date)::int week_count,
      COALESCE(SUM(total) FILTER (WHERE sale_date::date>=date_trunc('week',CURRENT_DATE)::date),0)::numeric week_total,
      COUNT(*) FILTER (WHERE sale_date::date>=date_trunc('month',CURRENT_DATE)::date)::int month_count,
      COALESCE(SUM(total) FILTER (WHERE sale_date::date>=date_trunc('month',CURRENT_DATE)::date),0)::numeric month_total
      FROM sales WHERE sale_date::date>=date_trunc('month',CURRENT_DATE)::date`)
  ]);
  res.json({ products:p.rows[0], sales:s.rows[0], salesPeriods:salesPeriods.rows[0], purchases:t.rows[0], lowStock:low.rows[0].count, lowStockItems:lowItems.rows, expiring:exp.rows[0].count, recent:recent.rows });
}));

app.get('/api/products', auth, asyncRoute(async (req,res) => {
  const q = `%${clean(req.query.q)}%`;
  const r = await pool.query(`SELECT * FROM products WHERE active=true AND (name ILIKE $1 OR COALESCE(sku,'') ILIKE $1 OR category ILIKE $1)
    ORDER BY name`,[q]);
  res.json(r.rows);
}));
const branchPeers = () => {
  let peers = [];
  try {
    const configured = JSON.parse(process.env.BRANCH_DIRECTORY || '[]');
    if (Array.isArray(configured)) peers = configured.filter(peer => peer && typeof peer.name === 'string' && typeof peer.url === 'string')
      .map(peer => ({ name: clean(peer.name), url: peer.url.replace(/\/+$/, '') }))
      .filter(peer => ['http:', 'https:'].includes(new URL(peer.url).protocol));
  } catch { peers = []; }
  return [...new Map(peers.map(peer => [peer.url.toLowerCase(), peer])).values()];
};
function validBranchToken(candidate) {
  const expected = process.env.BRANCH_NETWORK_TOKEN || '';
  const provided = String(candidate || '');
  if (expected.length < 32 || !provided) return false;
  const left = Buffer.from(expected), right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
app.get('/api/internal/branch-stock', asyncRoute(async (req,res) => {
  if (!validBranchToken(req.get('x-branch-network-token'))) return res.status(401).json({ error: 'Unauthorized.' });
  const term = clean(req.query.q).slice(0, 100);
  if (term.length < 2) return res.status(400).json({ error: 'Search term must contain at least two characters.' });
  const q = `%${term}%`;
  const result = await pool.query(`SELECT name,sku,quantity FROM products
    WHERE active=true AND quantity>0 AND (name ILIKE $1 OR COALESCE(sku,'') ILIKE $1)
    ORDER BY name LIMIT 30`, [q]);
  res.json({ products: result.rows });
}));
app.get('/api/branches', isAdmin, (req,res) => {
  res.json({ enabled: false, branches: branchPeers().map((branch,index) => ({ id:String(index+1), name:branch.name, url:branch.url, databaseReady:true })) });
});
app.post('/api/branches', isAdmin, (req,res) => res.status(501).json({ error: 'Automatic branch creation is not configured. Deploy each branch with its own Neon connection and add it to BRANCH_DIRECTORY.' }));
app.get('/api/branch-availability', auth, asyncRoute(async (req,res) => {
  const term = clean(req.query.q).slice(0, 100);
  if (term.length < 2) return res.status(400).json({ error: 'Enter at least two characters to search other branches.' });
  const peers = branchPeers();
  if (!peers.length || (process.env.BRANCH_NETWORK_TOKEN || '').length < 32)
    return res.status(503).json({ error: 'Other branch availability is not configured for this site.' });
  const branches = await Promise.all(peers.map(async peer => {
    try {
      const url = new URL(`${peer.url}/api/internal/branch-stock`);
      url.searchParams.set('q', term);
      const response = await fetch(url, {
        headers: { 'x-branch-network-token': process.env.BRANCH_NETWORK_TOKEN },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return { name: peer.name, online: false, products: [] };
      const data = await response.json();
      return { name: peer.name, online: true, products: Array.isArray(data.products) ? data.products : [] };
    } catch {
      return { name: peer.name, online: false, products: [] };
    }
  }));
  res.json({ branches });
}));
app.post('/api/products', isAdmin, asyncRoute(async (req,res) => {
  const b=req.body;
  if (!clean(b.name) || !Number.isInteger(num(b.quantity)) || num(b.quantity)<0) return res.status(400).json({error:'Medicine name and a valid opening quantity are required.'});
  const r=await pool.query(`INSERT INTO products(name,category,sku,batch_number,expiry_date,cost_price,selling_price,quantity,reorder_level)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [clean(b.name),clean(b.category),clean(b.sku)||null,clean(b.batch_number),b.expiry_date||null,num(b.cost_price||0),num(b.selling_price||0),num(b.quantity),num(b.reorder_level||0)]);
  const p=r.rows[0];
  if(p.quantity) await pool.query(`INSERT INTO stock_movements(product_id,movement_type,quantity_change,balance_after,reference,user_id)
    VALUES($1,'OPENING',$2,$2,'Opening stock',$3)`,[p.id,p.quantity,req.session.user.id]);
  emitStock(p.id,{name:p.name,quantity:p.quantity,reorderLevel:p.reorder_level,isLow:p.quantity<=p.reorder_level,alert:p.quantity<=p.reorder_level,movementType:'OPENING'});emitDashboard();res.status(201).json(p);
}));
app.put('/api/products/:id', isAdmin, asyncRoute(async (req,res) => {
  const b=req.body;
  const r=await pool.query(`UPDATE products SET name=$1,category=$2,sku=$3,batch_number=$4,expiry_date=$5,cost_price=$6,selling_price=$7,reorder_level=$8,updated_at=NOW()
    WHERE id=$9 AND active=true RETURNING *`,
    [clean(b.name),clean(b.category),clean(b.sku)||null,clean(b.batch_number),b.expiry_date||null,num(b.cost_price),num(b.selling_price),num(b.reorder_level),req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Medicine not found.'});
  const p=r.rows[0];emitStock(p.id,{name:p.name,quantity:p.quantity,reorderLevel:p.reorder_level,isLow:p.quantity<=p.reorder_level,alert:false,movementType:'PRODUCT_UPDATED'});emitDashboard();res.json(p);
}));
app.post('/api/products/:id/adjust', isAdmin, asyncRoute(async (req,res) => {
  const delta=num(req.body.quantity_change);
  if(!Number.isInteger(delta)||delta===0)return res.status(400).json({error:'Enter a non-zero whole-number adjustment.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query('SELECT * FROM products WHERE id=$1 AND active=true FOR UPDATE',[req.params.id]);
    if(!r.rowCount)throw new Error('Medicine not found.');
    const p=r.rows[0],next=p.quantity+delta;
    if(next<0)throw new Error('Adjustment would make stock negative.');
    await client.query('UPDATE products SET quantity=$1,updated_at=NOW() WHERE id=$2',[next,p.id]);
    await client.query(`INSERT INTO stock_movements(product_id,movement_type,quantity_change,balance_after,reference,note,user_id)
      VALUES($1,'ADJUSTMENT',$2,$3,'Manual adjustment',$4,$5)`,[p.id,delta,next,clean(req.body.note),req.session.user.id]);
    await client.query('COMMIT');emitStock(p.id,{name:p.name,quantity:next,reorderLevel:p.reorder_level,isLow:next<=p.reorder_level,alert:delta<0&&p.quantity>p.reorder_level&&next<=p.reorder_level,movementType:'ADJUSTMENT'});emitDashboard();res.json({quantity:next});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.delete('/api/products/:id', isAdmin, asyncRoute(async (req,res) => {
  const r=await pool.query('UPDATE products SET active=false WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Medicine not found.'});
  emitDashboard();res.json({ok:true});
}));

app.get('/api/suppliers', isAdmin, asyncRoute(async (req,res) => {
  const r=await pool.query('SELECT * FROM suppliers ORDER BY name');res.json(r.rows);
}));
app.post('/api/suppliers', isAdmin, asyncRoute(async (req,res) => {
  const b=req.body;if(!clean(b.name))return res.status(400).json({error:'Supplier name is required.'});
  const r=await pool.query(`INSERT INTO suppliers(name,contact_person,phone,email,address) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [clean(b.name),clean(b.contact_person),clean(b.phone),clean(b.email),clean(b.address)]);
  res.status(201).json(r.rows[0]);
}));
app.put('/api/suppliers/:id', isAdmin, asyncRoute(async (req,res) => {
  const b=req.body;
  const r=await pool.query(`UPDATE suppliers SET name=$1,contact_person=$2,phone=$3,email=$4,address=$5 WHERE id=$6 RETURNING *`,
    [clean(b.name),clean(b.contact_person),clean(b.phone),clean(b.email),clean(b.address),req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Supplier not found.'});res.json(r.rows[0]);
}));

app.post('/api/purchases', isAdmin, asyncRoute(async (req,res) => {
  const {supplier_id,invoice_number,purchase_date,notes,items}=req.body;
  if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'Add at least one purchase item.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let total=0, prepared=[];
    for(const item of items){
      const qty=num(item.quantity),cost=num(item.unit_cost);
      if(!validInt(qty)||!Number.isFinite(cost)||cost<0)throw new Error('Purchase quantities and costs must be valid.');
      const pr=await client.query('SELECT * FROM products WHERE id=$1 AND active=true FOR UPDATE',[item.product_id]);
      if(!pr.rowCount)throw new Error('A selected medicine could not be found.');
      const line=qty*cost;total+=line;prepared.push({p:pr.rows[0],qty,cost,line});
    }
    const pur=await client.query(`INSERT INTO purchases(supplier_id,invoice_number,purchase_date,total,notes,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [supplier_id||null,clean(invoice_number),purchase_date||new Date().toISOString().slice(0,10),total,clean(notes),req.session.user.id]);
    for(const it of prepared){
      const balance=it.p.quantity+it.qty;
      await client.query('UPDATE products SET quantity=$1,cost_price=$2,updated_at=NOW() WHERE id=$3',[balance,it.cost,it.p.id]);
      await client.query('INSERT INTO purchase_items(purchase_id,product_id,quantity,unit_cost,line_total) VALUES($1,$2,$3,$4,$5)',
        [pur.rows[0].id,it.p.id,it.qty,it.cost,it.line]);
      await client.query(`INSERT INTO stock_movements(product_id,movement_type,quantity_change,balance_after,reference,user_id)
        VALUES($1,'PURCHASE',$2,$3,$4,$5)`,[it.p.id,it.qty,balance,`Purchase ${pur.rows[0].id}`,req.session.user.id]);
    }
    await client.query('COMMIT');
    prepared.forEach(it=>emitStock(it.p.id,{name:it.p.name,quantity:it.p.quantity+it.qty,reorderLevel:it.p.reorder_level,isLow:it.p.quantity+it.qty<=it.p.reorder_level,alert:false,movementType:'PURCHASE'}));emitDashboard();
    res.status(201).json({purchase:pur.rows[0],total});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.get('/api/purchases', isAdmin, asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT pu.*,s.name supplier_name,u.name created_by_name FROM purchases pu
    LEFT JOIN suppliers s ON s.id=pu.supplier_id LEFT JOIN users u ON u.id=pu.created_by ORDER BY pu.created_at DESC LIMIT 300`);
  res.json(r.rows);
}));

async function saleReceiptPayload(client,sale,cashier){
  const detail=await client.query(`SELECT si.*,p.sku FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,[sale.id]);
  return {sale,items:detail.rows,cashier,pharmacy:{
    name:process.env.PHARMACY_NAME||'My Pharmacy',address:process.env.PHARMACY_ADDRESS||'Lusaka, Zambia',
    phone:process.env.PHARMACY_PHONE||'',currency:process.env.CURRENCY||'ZMW'
  }};
}
app.post('/api/sales', auth, asyncRoute(async (req,res) => {
  const {items,payment_method,discount,idempotency_key,amount_paid}=req.body;
  if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'Add at least one medicine to the sale.'});
  const idempotencyKey=clean(idempotency_key);
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey))return res.status(400).json({error:'A valid sale request key is required.'});
  const disc=num(discount||0);
  if(!Number.isFinite(disc)||disc<0)return res.status(400).json({error:'Discount is invalid.'});
  const method=clean(payment_method)||'Cash';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let subtotal=0, prepared=[];
    const ids=[...new Set(items.map(i=>num(i.product_id)))].sort((a,b)=>a-b);
    const lock=await client.query('SELECT * FROM products WHERE id=ANY($1::bigint[]) AND active=true ORDER BY id FOR UPDATE',[ids]);
    const byId=new Map(lock.rows.map(p=>[String(p.id),p]));
    const combined=new Map();
    for(const item of items){
      const id=String(item.product_id),qty=num(item.quantity);
      if(!validInt(qty))throw new Error('Sale quantities must be positive whole numbers.');
      combined.set(id,(combined.get(id)||0)+qty);
    }
    for(const [id,qty] of combined){
      const p=byId.get(id);if(!p)throw new Error('A selected medicine is unavailable.');
      if(p.quantity<qty)throw new Error(`Insufficient stock for ${p.name}. Available: ${p.quantity}.`);
      const price=num(p.selling_price),line=price*qty;subtotal+=line;
      prepared.push({p,qty,price,line});
    }
    if(disc>subtotal)throw new Error('Discount cannot exceed the sale subtotal.');
    const total=subtotal-disc;
    const paid=method.toLowerCase()==='cash'?num(amount_paid):total;
    if(!Number.isFinite(paid)||paid<total){const error=new Error('Amount paid must cover the sale total.');error.statusCode=400;throw error;}
    const change=Math.max(0,paid-total),receipt=receiptNo();
    const sale=await client.query(`INSERT INTO sales(receipt_number,subtotal,discount,total,amount_paid,change_due,idempotency_key,payment_method,cashier_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [receipt,subtotal,disc,total,paid,change,idempotencyKey,method,req.session.user.id]);
    for(const it of prepared){
      const balance=it.p.quantity-it.qty;
      await client.query('UPDATE products SET quantity=$1,updated_at=NOW() WHERE id=$2',[balance,it.p.id]);
      await client.query(`INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total)
        VALUES($1,$2,$3,$4,$5,$6)`,[sale.rows[0].id,it.p.id,it.p.name,it.qty,it.price,it.line]);
      await client.query(`INSERT INTO stock_movements(product_id,movement_type,quantity_change,balance_after,reference,user_id)
        VALUES($1,'SALE',$2,$3,$4,$5)`,[it.p.id,-it.qty,balance,receipt,req.session.user.id]);
    }
    await client.query('COMMIT');
    prepared.forEach(it=>emitStock(it.p.id,{name:it.p.name,quantity:it.p.quantity-it.qty,reorderLevel:it.p.reorder_level,isLow:it.p.quantity-it.qty<=it.p.reorder_level,alert:it.p.quantity>it.p.reorder_level&&it.p.quantity-it.qty<=it.p.reorder_level,movementType:'SALE'}));emitDashboard();
    res.status(201).json(await saleReceiptPayload(client,sale.rows[0],req.session.user.name));
  }catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505'){
      const existing=await client.query('SELECT * FROM sales WHERE idempotency_key=$1',[idempotencyKey]);
      if(existing.rowCount)return res.status(200).json(await saleReceiptPayload(client,existing.rows[0],req.session.user.name));
    }
    throw e;
  }finally{client.release();}
}));
app.get('/api/sales', auth, asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT s.*,u.name cashier_name FROM sales s LEFT JOIN users u ON u.id=s.cashier_id
    ORDER BY s.sale_date DESC LIMIT 500`);res.json(r.rows);
}));
app.get('/api/sales/:id', auth, asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT s.*,u.name cashier_name FROM sales s LEFT JOIN users u ON u.id=s.cashier_id WHERE s.id=$1`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Sale not found.'});
  const items=await pool.query('SELECT * FROM sale_items WHERE sale_id=$1',[req.params.id]);
  res.json({sale:r.rows[0],items:items.rows,pharmacy:{name:process.env.PHARMACY_NAME||'My Pharmacy',address:process.env.PHARMACY_ADDRESS||'Lusaka, Zambia',phone:process.env.PHARMACY_PHONE||'',currency:process.env.CURRENCY||'ZMW'}});
}));

app.get('/api/movements', isAdmin, asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT sm.*,p.name product_name,u.name user_name FROM stock_movements sm
    JOIN products p ON p.id=sm.product_id LEFT JOIN users u ON u.id=sm.user_id ORDER BY sm.created_at DESC LIMIT 500`);
  res.json(r.rows);
}));
app.get('/api/reports', isAdmin, asyncRoute(async(req,res)=>{
  const [sales,purchases,top]=await Promise.all([
    pool.query(`SELECT sale_date::date day,COUNT(*)::int transactions,COALESCE(SUM(total),0)::numeric total
      FROM sales WHERE sale_date>=CURRENT_DATE-INTERVAL '29 days' GROUP BY day ORDER BY day`),
    pool.query(`SELECT purchase_date day,COUNT(*)::int transactions,COALESCE(SUM(total),0)::numeric total
      FROM purchases WHERE purchase_date>=CURRENT_DATE-INTERVAL '29 days' GROUP BY day ORDER BY day`),
    pool.query(`SELECT product_name,SUM(quantity)::int units,SUM(line_total)::numeric revenue FROM sale_items
      GROUP BY product_name ORDER BY units DESC LIMIT 10`)
  ]);
  res.json({sales:sales.rows,purchases:purchases.rows,topProducts:top.rows});
}));
app.get('/api/users', isAdmin, asyncRoute(async(req,res)=>{
  const r=await pool.query('SELECT id,name,email,role,active,created_at FROM users ORDER BY name');res.json(r.rows);
}));
app.post('/api/users', isAdmin, asyncRoute(async(req,res)=>{
  const {name,email,password,role}=req.body;
  if(!clean(name)||!clean(email)||String(password||'').length<12||!['admin','cashier'].includes(role))
    return res.status(400).json({error:'Enter a name, valid email, role and password of at least 12 characters.'});
  const hash=await bcrypt.hash(password,12);
  const r=await pool.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role,active',
    [clean(name),clean(email).toLowerCase(),hash,role]);res.status(201).json(r.rows[0]);
}));
app.patch('/api/users/:id', isAdmin, asyncRoute(async(req,res)=>{
  if(String(req.params.id)===String(req.session.user.id)&&req.body.active===false)return res.status(400).json({error:'You cannot deactivate your own account.'});
  const r=await pool.query('UPDATE users SET active=$1 WHERE id=$2 RETURNING id,name,email,role,active',[!!req.body.active,req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'User not found.'});res.json(r.rows[0]);
}));

io.on('connection',(socket)=>{
  const user=socket.request.session?.user;
  if(!user)return socket.disconnect(true);
  socket.emit('connected',{user:user.name});
});
app.use('/api', (err,req,res,next)=>{
  console.error(err);
  if(err.code==='23505')return res.status(409).json({error:'A record with that unique value already exists.'});
  res.status(err.statusCode||500).json({error:err.message||'Unexpected server error.'});
});
app.get('*',(req,res)=>res.sendFile(require('path').join(__dirname,'public','index.html')));

(async()=>{
  try{
    await initDb();
    server.listen(PORT,()=>console.log(`PharmaTrack running on http://localhost:${PORT}`));
  }catch(e){console.error('Startup failed:',e);process.exit(1);}
})();
