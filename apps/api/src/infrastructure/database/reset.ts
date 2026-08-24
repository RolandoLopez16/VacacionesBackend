import { MongoStore } from "../../adapters/outbound/mongodb/mongoStore.js";
import { AuthService, refreshSecretFrom } from "../../application/services/authService.js";
import { env } from "../config/env.js";

if (env.STORAGE_MODE !== "mongo") throw new Error("Database reset requires STORAGE_MODE=mongo");
const store = await MongoStore.connect(env.MONGODB_URI, env.MONGODB_DATABASE);
await store.resetVacationDatabase();
const auth = new AuthService(
  store,
  {
    jwtSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET ?? refreshSecretFrom(env.JWT_SECRET),
    accessExpiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },
  store,
);
await auth.ensureAdmin(env.BOOTSTRAP_ADMIN_USERNAME, env.BOOTSTRAP_ADMIN_PASSWORD);
await store.close();
console.log(`Database ${env.MONGODB_DATABASE} reset and admin user initialized.`);
