# MongoDB adapter boundary

`MongoStore` uses the official MongoDB driver, typed collections, indexes and an explicit `_id` stripping mapper. It implements the same `VacationStore` port as `MemoryStore`, so the domain and use cases remain independent from MongoDB. Set `STORAGE_MODE=mongo` to enable it.
