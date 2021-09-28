import express from "express";
import fetch from "node-fetch";
import {
  ApiClient,
  ApiClientInMemoryContextProvider,
} from "@northflank/js-client";
import {
  getAddonBackups,
  getMinioDetails,
  getPostgresqlDetails,
  getServiceDetails,
} from "../../api/strapi.js";

const router = express.Router();

function getRandomArbitrary(min, max, arr) {
  arr = {
    x: Date.now(),
    y: Math.random() * (max - min) + min,
    y2: Math.random() * (max - min) + min,
  };

  return arr;
}

import MongoDbHandler from "../../api/mongoUtil.js";

import healthCodes from "../../healthCodes.js";

const northflankToken = process.env.NORTHFLANK_TOKEN;

const GitHubAPI = async (url) => {
  return await (
    await fetch(new URL(url, "https://api.github.com").toString(), {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_AUTH}`,
      },
    })
  ).json();
};

router.get("/strapi-github-repo", async (req, res) => {
  try {
    const [response, commits] = await Promise.all([
      GitHubAPI(`/repos/strapi/strapi`),
      GitHubAPI(`/repos/strapi/strapi/commits`),
    ]);
    response.lastCommit = commits?.[0];
    res.status(healthCodes.SUCCESS).send(response);
  } catch (error) {
    console.log(error);
    console.log("Error fetching Strapi repo");
  }
});

router.post("/chart-data", (req, res) => {
  let arr = req?.body?.data;
  const data = {
    memory: getRandomArbitrary(5, 70),
    cpu: getRandomArbitrary(5, 70),
    network: getRandomArbitrary(0.3, 2.75),
    requests: getRandomArbitrary(0.3, 2.75),
  };
  res.status(healthCodes.SUCCESS).send(data);
});

router.post("/project", async (req, res) => {
  const request = req.body;
  if (
    request?.projectName !== "[slug]" &&
    request?.projectName !== "undefined"
  ) {
    const projectFromDb = await MongoDbHandler.Projects.fetchProject({
      projectName: request?.projectName,
    });
    if (projectFromDb) {
      await loadResources({ projectName: request?.projectName });
      const response = await MongoDbHandler.Projects.fetchProject({
        projectName: request?.projectName,
      });
      res.status(healthCodes.SUCCESS).send(response);
    } else res.status(healthCodes.BAD_REQUEST);
  } else res.status(healthCodes.NOT_STARTED);
});

router.post("/refresh-projects", async (req, res) => {
  refreshProjects();
  const response = await MongoDbHandler.Projects.fetchProjects();
  res.status(healthCodes.SUCCESS).send(response);
});

router.post("/projects", async (req, res) => {
  const response = await MongoDbHandler.Projects.fetchProjects();
  res.status(healthCodes.SUCCESS).send(response);
});

const refreshProjects = async () => {
  const projects = await MongoDbHandler.Projects.fetchProjects();
  await Promise.all(
    projects.map(({ projectName }) => loadResources({ projectName }))
  );
};

const loadResources = async ({ projectName }) => {
  const contextProvider = new ApiClientInMemoryContextProvider();
  await contextProvider.addContext({
    name: "application",
    token: northflankToken,
  });

  const apiClient = new ApiClient(contextProvider);

  const serviceDetails = await getServiceDetails({
    projectName,
    serviceId: "strapi",
    apiClient,
  });
  if (serviceDetails.error) {
    console.log(serviceDetails);
  }

  const minioDetails = await getMinioDetails({
    projectName,
    minioId: "minio",
    apiClient,
  });
  if (minioDetails.error) {
    console.log(minioDetails);
  }

  const postgresqlDetails = await getPostgresqlDetails({
    projectName,
    postgresqlId: "postgresql",
    apiClient,
  });
  if (postgresqlDetails.error) {
    console.log(postgresqlDetails);
  }

  const backups = await getAddonBackups({
    projectName,
    addonId: "postgresql",
    apiClient,
  });
  if (backups.error) {
    console.log(backups);
  }
};

export default router;
