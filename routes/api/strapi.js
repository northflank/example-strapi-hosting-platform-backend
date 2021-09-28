import express from "express";
import healthCodes from "../../healthCodes.js";
import {
  ApiClient,
  ApiClientInMemoryContextProvider,
} from "@northflank/js-client";

import {
  createProject,
  createCombinedService,
  createPostgreSQL,
  checkServiceBuild,
  createMinIO,
  createSecretGroup,
  fetchMinioCredentials,
  checkServiceContainers,
  createManualJob,
  addSubdomain,
  triggerJob,
  getMinioDetails,
  getPostgresqlDetails,
  fetchPostgresqlCredentials,
  backupAddon,
  restoreAddonBackup,
  deleteAddonBackup,
  getJobBuild
} from "../../api/strapi.js";
import MongoDbHandler from "../../api/mongoUtil.js";

const router = express.Router();

const contextProvider = new ApiClientInMemoryContextProvider();
await contextProvider.addContext({
  name: "application",
  token: process.env.NORTHFLANK_TOKEN,
});

const apiClient = new ApiClient(contextProvider);

router.post("/backup-addon", async (req, res) => {
  const request = req.body;
  const response = await backupAddon({
    projectName: request.projectName,
    addonId: request.addonId,
    apiClient,
  });
  res.send(response);
});

router.post("/restore-addon-backup", async (req, res) => {
  const request = req.body;
  const response = await restoreAddonBackup({
    projectName: request.projectName,
    addonId: request.addonId,
    backupId: request.backupId,
    apiClient,
  });
  res.send(response);
});

router.post("/delete-addon-backup", async (req, res) => {
  const request = req.body;
  const response = await deleteAddonBackup({
    projectName: request.projectName,
    addonId: request.addonId,
    backupId: request.backupId,
    apiClient,
  });
  res.send(response);
});

router.post("/create-deployment", async (req, res) => {
  const request = req.body;
  const response = await MongoDbHandler.Projects.startNewProject({
    publicProjectName: request.publicProjectName,
    customerId: request.customerId,
  });
  res.status(healthCodes.ACCEPTED).send(response);
  setTimeout(async () => {
    await main({
      projectName: response?.slug,
    });
  }, 3000);
});

const main = async ({ projectName }) => {
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "project",
    health: healthCodes.IN_PROGRESS,
  });
  const newProject = await createProject({ projectName, apiClient });
  if (newProject.error) {
    console.log(newProject);
    return newProject;
  }

  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "job",
    health: healthCodes.IN_PROGRESS,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "service",
    health: healthCodes.IN_PROGRESS,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "postgresql",
    health: healthCodes.IN_PROGRESS,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "minio",
    health: healthCodes.IN_PROGRESS,
  });

  const [job, combinedService, postgresql, minio] = await Promise.all([
    createManualJob({
      projectName,
      apiClient,
    }),
    createCombinedService({
      projectName,
      apiClient,
    }),
    createPostgreSQL({
      projectName,
      apiClient,
    }),
    createMinIO({
      projectName,
      apiClient,
    }),
  ]);

  if (job.error) {
    console.log(job);
    return job;
  }

  if (combinedService.error) {
    console.log(combinedService);
    return combinedService;
  }

  if (postgresql.error) {
    console.log(postgresql);
    return postgresql;
  }

  if (minio.error) {
    console.log(minio);
    return minio;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 3000);
  });

  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "domain",
    health: healthCodes.IN_PROGRESS,
  });
  const project = await MongoDbHandler.Projects.fetchProject({ projectName });
  const projectDomainName = project?.projectDomain;
  const domain = await addSubdomain({
    projectName,
    subdomain: projectDomainName,
    apiClient,
  });
  if (domain.error) {
    console.log(domain);
    return domain;
  }

  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "secrets",
    health: healthCodes.IN_PROGRESS,
  });
  const secretGroup = await createSecretGroup({
    projectName,
    minio: minio.id,
    postgresql: postgresql.id,
    apiClient,
  });
  if (secretGroup.error) {
    console.log(secretGroup);
    return secretGroup;
  }

  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "fetchMinio",
    health: healthCodes.IN_PROGRESS,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "fetchPostgresql",
    health: healthCodes.IN_PROGRESS,
  });

  const [postgresqlCredentials, minioCredentials] = await Promise.all([
    await fetchPostgresqlCredentials({
      projectName,
      addonId: "postgresql",
      apiClient,
    }),
    await fetchMinioCredentials({
      projectName,
      addonId: "minio",
      apiClient,
    }),
  ]);

  if (postgresqlCredentials.error) {
    console.log(postgresqlCredentials);
    return postgresqlCredentials;
  }

  if (minioCredentials.error) {
    console.log(minioCredentials);
    return minioCredentials;
  }

  const configureMinioBucket = async () => {
    const data = await getMinioDetails({
      projectName,
      minioId: "minio",
      apiClient,
    });
    const jobBuild = await getJobBuild({
      projectName,
      jobId: "minio-setup-control",
      apiClient,
    });

    if (data?.status === "failed") {
      clearInterval(minioCheck);
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "minio",
        health: healthCodes.FAILED,
        message: "Creation failed",
      });
    } else if (data?.status === "triggerAllocation") {
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "minio",
        health: healthCodes.STAGING,
      });
    } else if (data?.status === "running" && jobBuild?.concluded) {
      clearInterval(minioCheck);
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "minio",
        health: healthCodes.SUCCESS,
      });
      await triggerJob({ projectName, apiClient });
    }
  };

  const checkPostgres = async () => {
    const data = await getPostgresqlDetails({
      projectName: projectName,
      postgresqlId: "postgresql",
      apiClient: apiClient,
    });

    if (data?.status === "triggerAllocation") {
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "postgresql",
        health: healthCodes.STAGING,
      });
    } else if (data?.status === "running") {
      clearInterval(postgresqlCheck);
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "postgresql",
        health: healthCodes.SUCCESS,
      });
    }
  };

  const checkService = async () => {
    const buildStatus = await checkServiceBuild({
      projectName: projectName,
      serviceId: "strapi",
      apiClient: apiClient,
    });
    const podStatus = await checkServiceContainers({
      projectName: projectName,
      serviceId: "strapi",
      apiClient: apiClient,
    });

    switch (buildStatus) {
      case "STARTING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.BUILD_STARTING,
        });
        break;
      case "CLONING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.BUILD_CLONING,
        });
        break;
      case "BUILDING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.BUILDING,
        });
        break;
      case "UPLOADING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.BUILD_UPLOADING,
        });
        break;
      case "FAILURE":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.FAILED,
          message: "Build failed",
        });
        clearInterval(serviceCheck);
        break;
    }
    switch (podStatus) {
      case "TASK_STARTING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.CONTAINER_STARTING,
        });
        break;
      case "TASK_RUNNING":
        await MongoDbHandler.Projects.addNewResponse({
          projectName,
          key: "service",
          health: healthCodes.SUCCESS,
        });
        clearInterval(serviceCheck);
        break;
    }
  };

  let minioCheck = setInterval(configureMinioBucket, 10000);
  let postgresqlCheck = setInterval(checkPostgres, 10000);
  let serviceCheck = setInterval(checkService, 10000);
  return {
    success: true,
    code: healthCodes.ACCEPTED,
    message: "Strapi created",
    apiResponse: "success",
  };
};

export default router;
