import MongoDbHandler from "../../api/mongoUtil.js";
import healthCodes from "../../healthCodes.js";
import express from "express";

const router = express.Router();

router.post("/add-new-response", async (req, res) => {
  const request = req.body;
  const response = await MongoDbHandler.Projects.addNewResponse({
    projectName: request.projectName,
    key: request.key,
    health: request.health,
    message: request.message,
  });
  console.log(response);
  res.status(healthCodes.SUCCESS).send(JSON.stringify(response));
});

export default router;
