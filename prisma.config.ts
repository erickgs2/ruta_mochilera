import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 reads the schema location, the migrations directory and the
// connection string from this file: the datasource block in schema.prisma no
// longer carries a `url`, and the CLI no longer loads `.env` on its own, hence
// the `dotenv/config` import above.
export default defineConfig({
  schema: 'libs/db/prisma/schema.prisma',
  migrations: {
    path: 'libs/db/prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
