# PharmaTrack — Multi-user Pharmacy Management System

A runnable full-stack starter application using HTML, CSS, JavaScript, Node.js, Express, PostgreSQL and Socket.IO.

## Features
- Login with server-side sessions stored in PostgreSQL.
- Administrator and cashier roles with server-side authorization.
- Medicines, batches, expiry dates, cost/selling prices and reorder levels.
- Sales cart, payment method, discounts and printable receipt.
- Supplier directory.
- Purchase receiving that increases stock.
- Manual stock adjustments with a movement audit trail.
- Dashboard, low-stock/expiry counts and basic 30-day reports.
- Socket.IO events refresh connected users after committed sales, purchases and adjustments.
- Database row locks and transactions prevent overselling and partial purchase/sale updates.

## Requirements
- Node.js 20+
- A modern browser

## Local setup
1. In a terminal in this project folder run:

   ```bash
   npm install
   npm start
   ```

2. Open `http://localhost:3000`.
3. Sign in with `admin@example.com` and `ChangeThisPassword123!` on the first run.
4. Change the administrator password before using the app with real data.
5. Create cashier accounts from **User accounts**.

Local start runs an embedded PostgreSQL-compatible database and stores its data in `.local-db`. The database and schema are created automatically. The first administrator is created only when the users table is empty. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, and other app settings in `.env` if needed; no `DATABASE_URL` is required for local start.

### Run another branch locally

Administrators can open **Branches** in the app and create a branch by name. The new site gets its own login, session secret, and database. The setup page shows the new URL and initial admin credentials once. Branch sites are added automatically to cross-branch stock lookup.

You can also start a branch from a terminal using a unique name and app port:

```bash
npm run start:branch -- --branch=ndola --port=3001
```

Open `http://localhost:3001`. On first start, the launcher creates `.branches/ndola/.env` and `.branches/ndola/database`, generates a separate administrator password, and prints that password once. Save it, then change it before using the account. Branch files and records remain separate from the main pharmacy and other branches. Use a different port for each running local branch.

### Host branches separately

Deploy the same app separately for each branch and assign each deployment its own PostgreSQL database and environment settings. Give each branch a unique `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`; set its own `PHARMACY_NAME`, address, and phone. Run `npm run start:postgres` for each hosted deployment. This keeps inventory, purchases, sales, suppliers, accounts, and reports isolated while preserving all system features at each site.

The in-app branch creator provisions independent instances on this local host. Hosted branch creation requires deploying a new app and database for the branch; this project is not connected to a hosting provider API.

To enable read-only stock lookup between hosted branches, set the same random `BRANCH_NETWORK_TOKEN` (at least 32 characters) on every site. Configure `BRANCH_DIRECTORY` on each site as a JSON array listing the *other* branches, for example `[{"name":"Ndola","url":"https://ndola.example.com"}]`. Keep branch sites on HTTPS and use a long, private token. Staff can use **Check branches** in Inventory to see matching medicines and available quantities; this lookup does not transfer or reserve stock. A branch that is offline is shown as unavailable. Leave `BRANCH_DIRECTORY=[]` to keep lookup disabled.

For local instances, add the matching other-site URLs to `.env` and each `.branches/<name>/.env`. Use `http://localhost:<port>` URLs and the same `BRANCH_NETWORK_TOKEN` in every local branch. The internal stock endpoint is protected by this shared token; it returns only medicine names, SKUs, and in-stock quantities.

For a regular PostgreSQL server, configure `DATABASE_URL` and run `npm run start:postgres` instead. Production deployments should use this command with a managed PostgreSQL database.

## Real-time stock behaviour
A sale/purchase/adjustment updates PostgreSQL inside a transaction. After commit, the server emits a Socket.IO event. Connected browser sessions refresh the affected inventory and dashboard. PostgreSQL is the source of truth; browser state is not used as the stock ledger.

## Deployment
Deploy the Node application to a Node-capable host (Render, Railway, Fly.io, VPS, etc.) and attach a managed PostgreSQL database. Configure all `.env.example` values in the host's environment settings. Use HTTPS and set `NODE_ENV=production` and `COOKIE_SECURE=true`. Configure the host's WebSocket support. If running multiple Node instances, add a Socket.IO Redis adapter (or another shared pub/sub adapter) so events reach sockets connected to every instance.

This app serves its front-end and API from the same origin. It is not a static-only Vercel deployment; the Node server and persistent PostgreSQL database must be hosted.

## Important production hardening before real pharmacy operations
This is a functional starter, not a certified pharmacy/ERP product. Before live use:
- Change the initial administrator password immediately and use a unique secret.
- Add HTTPS, database backups, monitoring, retention policy and restore testing.
- Add CSRF protection appropriate to the deployment, security review, password reset, MFA and account/session management.
- Add data validation, pagination, export controls and more comprehensive audit logging.
- Define jurisdiction-specific tax, controlled-medicine, prescription, dispensing, returns and privacy workflows with a qualified pharmacist and local compliance adviser.
- Confirm receipt/tax invoice requirements in Zambia.
- Add tests for concurrency, stock corrections, duplicate batches, returns and outages.
- Add product expiry/batch allocation (FEFO) and block dispensing expired stock before operational use.

## Roles
- **Administrator:** full access to users, inventory, supplier, purchasing, stock adjustments, reports and sales.
- **Cashier:** view inventory and process sales/receipts. No server-side access to admin endpoints.

## Currency and pharmacy identity
Set `CURRENCY`, `PHARMACY_NAME`, `PHARMACY_ADDRESS`, and `PHARMACY_PHONE` in `.env`.
