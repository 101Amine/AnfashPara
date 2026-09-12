# Cloudflare CI token scope

GitHub Actions stores the token as `CLOUDFLARE_API_TOKEN` and the account identifier as `CLOUDFLARE_ACCOUNT_ID`; neither value belongs in source control.

The token can edit Workers scripts and D1 databases only inside the selected `Aminebashrc@gmail.com's Account` account.

It can deploy `para-api`, apply D1 migrations, seed D1, and run the related Wrangler commands from CI.

It cannot manage DNS, zones, billing, domains, account members, email, R2, KV, or other Cloudflare products.

It cannot create additional API tokens, and its planned 90-day expiry limits how long forgotten credentials remain usable.
