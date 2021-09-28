import { MongoClient } from "mongodb";
import { Projects } from "./database.js";

const URI = process.env.MONGO_URI;
const DATABASE_NAME = process.env.MONGO_DB;

class MongoDbHandler {
  constructor() {
    this.client = new MongoClient(URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  }
  async init() {
    await this.client.connect();
    console.log("Connection to MongoDB established");
    this.db = this.client.db(DATABASE_NAME);
    this.Projects = new Projects(this.db);
  }
}

export default new MongoDbHandler();
