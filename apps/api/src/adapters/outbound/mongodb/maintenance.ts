import { ensureMongoIndexes } from "./indexes.js";
import { VACATION_COLLECTION_NAMES, type MongoContext } from "./mongoContext.js";

export async function resetVacationDatabase(context: MongoContext) {
  await Promise.all(
    VACATION_COLLECTION_NAMES.map((name) => context.collection<unknown>(name).deleteMany({})),
  );
  await ensureMongoIndexes(context);
}
