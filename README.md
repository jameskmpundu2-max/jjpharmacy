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

## Run with Neon

1. Copy `.env.example` to `.env`.
2. In the Neon Console, create or select a project and copy its pooled connection string. Put it in `DATABASE_URL` in `.env`. Keep this secret out of source control.
3. Set `BRANCH_ID=main`, a unique `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `.env`.
4. Run `npm install` and `npm start`, then open `http://localhost:3000`.

All application reads and writes, including login sessions, inventory, sales, and reports, use the configured Neon database. Startup stops if `DATABASE_URL` is missing or does not point to a Neon host. The schema is created automatically. When `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured, they are synchronized to the matching administrator account at startup, so the configured credentials remain valid. Use the same variables in the hosting provider's environment settings for a deployed app; local `.env` values are not uploaded by Git.

Existing records in the former local `.local-db` are not copied automatically. Keep that folder until a separate migration into Neon has been completed and verified.

### Branches

Deploy each pharmacy branch as a separate application using the same Neon `DATABASE_URL`. Give each deployment a unique `BRANCH_ID` containing lowercase letters and numbers (for example `main`, `ndola`, or `kitwe`). The default `main` branch continues using the existing `public` schema; every other branch gets its own schema in the same database, so users, inventory, sales, purchases, suppliers and sessions stay separate. Each schema is initialized automatically. The app uses the pooled endpoint for `main`; for another branch it switches a pooled Neon hostname to the direct endpoint so PostgreSQL can select that branch's schema at connection startup. This is required because Neon PgBouncer rejects the `search_path` startup option. The non-main branch pool defaults to one connection. Set `PHARMACY_NAME`, branch administrator credentials, `SESSION_SECRET`, and other pharmacy details for each deployment. To show other branch sites and enable read-only stock lookup, configure a shared `BRANCH_NETWORK_TOKEN` and a `BRANCH_DIRECTORY` JSON array of deployed branches, for example `[ {"name":"Ndola","url":"https://ndola.example.com"} ]`. Branch deployment and `BRANCH_ID` configuration are done in the hosting provider; the in-app branch form cannot provision deployments.

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
