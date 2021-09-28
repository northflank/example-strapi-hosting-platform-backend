import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import strapi from "./routes/api/strapi.js";
import fetch from "./routes/api/fetch.js";
import external from "./routes/api/external.js";
import cors from "cors";

import MongoDbHandler from "./api/mongoUtil.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.options("/", cors());

let whitelist = {
  full: ["http://localhost:3000",
    "https://www.strapi.run",
    "https://www.strapi.live",
    "https://strapi.run",
    "https://strapi.live"],
  partial: ['nort-xjjq.code.run']
};
let corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.full.indexOf(origin) !== -1 || whitelist.partial.some(p => origin.endsWith(p))) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
      return false;
    }
  },
};

async function start() {
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, "public")));
  await MongoDbHandler.init();
  app.use("/api/strapi", cors(corsOptions), strapi);
  app.use("/api/fetch", cors(corsOptions), fetch);
  app.use("/api/external", external);
  app.listen(process.env.PORT, () =>
    console.log(`Server started on ${process.env.PORT}`)
  );
}

start();
