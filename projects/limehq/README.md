# LimeHQ

The shared login and permissions front door for every Limehouse Property
Management tool. Staff sign in here once, see every project they have
access to, and launch into whichever one they need. Each project then runs
independently from its own local session — LimeHQ isn't in the loop on
every subsequent click.

Replaces Microsoft Entra SSO, which was never fully finished (the Late
Rent Notices project still has placeholder `CHANGE_ME` Entra credentials)
and was more setup/maintenance overhead than it's worth for a 7-person
team.

See [`docs/auth-spec.md`](docs/auth-spec.md) for the full design (Oracle,
2026-07-16). Status: scaffolding only — no login or permissions logic is
built yet. Next step is Neo designing the database schema from the spec.

## Local development

```
npm install
cp .env.example .env   # fill in DATABASE_URL
npm run dev             # http://localhost:3300
```
