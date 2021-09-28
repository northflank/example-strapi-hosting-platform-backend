import MongoDbHandler from "../api/mongoUtil.js";
import fetch from "node-fetch";
import Minio from "minio";

import healthCodes from "../healthCodes.js";

const DOMAIN_NAME = process.env.DOMAIN_NAME;
const SERVICE_NAME = "strapi";
const NF_BASIC_PLAN = "nf-compute-20";
const NF_SERVICE_PLAN = "nf-compute-200";
const MINIO_VERSION = "2021.6.17";
const POSTGRESQL_VERSION = "13.4.0";
const PROJECT_REGION = "europe-west";
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: ["*"] },
      Action: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
      ],
      Resource: ["arn:aws:s3:::media"],
    },
    {
      Effect: "Allow",
      Principal: { AWS: ["*"] },
      Action: [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListMultipartUploadParts",
      ],
      Resource: ["arn:aws:s3:::media/*"],
    },
  ],
};
const DEFAULT_RETRY_DELAY = 1000;

class AbortErrorWrapper extends Error {
  constructor(wrappedError) {
    super();
  }
}

export const retry = (options) => (action) => {
  const { retries, retryDelayIncrease, retryDelayMultiplier } = options;

  let retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;
  let retryCount = 0;

  const retryRecursive = async () => {
    try {
      return await action(retryCount);
    } catch (e) {
      if (e instanceof AbortErrorWrapper) {
        throw e.wrappedError;
      }

      if (retryCount >= retries) {
        throw e;
      }

      retryCount += 1;

      if (retryDelayIncrease) retryDelay += retryDelayIncrease;
      if (retryDelayMultiplier) retryDelay *= retryDelayMultiplier;

      await new Promise((r) => setTimeout(() => r(), retryDelay));

      return retryRecursive();
    }
  };

  return retryRecursive();
};

const callWithRetry = async (
  method,
  args,
  options = { retries: 3, retryDelay: 2000 }
) =>
  await retry(options)(async (i) => {
    console.log("Running..");
    const { data, error } = await method(args);
    if (i === options.retries) {
      return { data, error };
    }
    if (error) throw error;
    return { data, error };
  });

export const createProject = async ({ projectName, apiClient }) => {
  const { data, error } = await apiClient.create.project({
    data: {
      name: projectName,
      region: PROJECT_REGION,
      description: "Strapi running on Northflank with PostgreSQL and MinIO",
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "project",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create project",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "project",
    health: healthCodes.SUCCESS,
  });
  console.log("Project created");
  return data;
};

export const configureMinio = async ({
  projectName,
  apiClient,
  minioCredentials,
}) => {
  await apiClient.forwarding.withAddonForwarding(
    { projectId: projectName, addonId: "minio" },
    async (forwardingData) => {
      await Promise.all(
        forwardingData.map(async (forwardingInfo) => {
          if (forwardingInfo.error) {
            console.log(forwardingInfo.error.message);
          } else {
            const addonId = forwardingInfo.data.id;
            const { port, address } = forwardingInfo.data;
            console.log("Forwarding addon:", addonId, address, port);

            await new Promise((resolve) => {
              setTimeout(resolve, 5000);
            });

            const minioClient = await new Minio.Client({
              endPoint: minioCredentials.envs.host,
              port: 9000,
              useSSL: true,
              accessKey: minioCredentials.secrets.accessKey,
              secretKey: minioCredentials.secrets.secretKey,
            });

            try {
              await minioClient.makeBucket("media");
              await MongoDbHandler.Projects.addNewResponse({
                projectName,
                key: "bucketCreated",
                health: healthCodes.SUCCESS,
              });
              console.log("Bucket created successfully.");
            } catch (error) {
              await MongoDbHandler.Projects.addNewResponse({
                projectName,
                key: "bucketCreated",
                health: healthCodes.FAILED,
                message: "Error creating bucket",
              });
              await MongoDbHandler.Projects.addNewResponse({
                projectName,
                key: "bucketPolicy",
                health: healthCodes.FAILED,
                message: "Error setting bucket policy",
              });

              console.log("Error creating bucket");
              console.log(error);
              return { error: true, message: error };
            }

            try {
              await minioClient.setBucketPolicy(
                "media",
                JSON.stringify(policy)
              );
              await MongoDbHandler.Projects.addNewResponse({
                projectName,
                key: "bucketPolicy",
                health: healthCodes.SUCCESS,
              });
              console.log("Bucket policy set successfully");
            } catch (error) {
              await MongoDbHandler.Projects.addNewResponse({
                projectName,
                key: "bucketPolicy",
                health: healthCodes.FAILED,
                message: "Error setting bucket policy",
              });
              console.log("Error setting bucket policy");
              console.log(error);
              return { error: true, message: error };
            }
          }
        })
      );
    },
    false
  );
  return { success: true };
};

export const triggerJob = async ({ projectName, apiClient }) => {
  const { data, error } = await callWithRetry(apiClient.start.job.run, {
    parameters: {
      projectId: projectName,
      jobId: "minio-setup-control",
    },
  });
  if (error) {
    console.log("Error running job");
    console.log(error);
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "bucketCreated",
      health: healthCodes.FAILED,
    });
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "bucketPolicy",
      health: healthCodes.FAILED,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not run Minio setup command",
      apiResponse: error.message,
    };
  }
  console.log("Job ran");
  return data;
};

export const createManualJob = async ({ projectName, apiClient }) => {
  const { data, error } = await callWithRetry(apiClient.create.job.manual, {
    parameters: { projectId: projectName },
    data: {
      name: "minio-setup-control",
      description: "MinIO Setup Control",
      billing: {
        deploymentPlan: NF_BASIC_PLAN,
      },
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      deployment: {
        vcs: {
          projectUrl: "https://github.com/northflank/minio-setup-control", // TODO remove l
          projectType: "github",
          projectBranch: "master",
        },
      },
      buildSettings: {
        dockerfile: {
          buildEngine: "kaniko",
          dockerFilePath: "/Dockerfile",
          dockerWorkDir: "/",
        },
      },
      environment: {
        PROJECT_NAME: projectName,
        RESPONSE_ENDPOINT: process.env.APP_URL,
      },
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "job",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create job",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "job",
    health: healthCodes.SUCCESS,
  });
  console.log("Job created");
  return data;
};

export const createCombinedService = async ({ projectName, apiClient }) => {
  const { data, error } = await callWithRetry(
    apiClient.create.service.combined,
    {
      parameters: {
        projectId: projectName,
      },
      data: {
        name: "Strapi",
        description: "Strapi combined service",
        billing: {
          deploymentPlan: NF_SERVICE_PLAN,
        },
        deployment: {
          instances: 1,
        },
        ports: [
          {
            name: "p1",
            internalPort: 1337,
            public: true,
            protocol: "HTTP",
          },
        ],
        vcsData: {
          projectUrl: "https://github.com/northflank/strapi-on-northflank",
          projectType: "github",
          projectBranch: "master",
        },
        buildSettings: {
          dockerfile: {
            buildEngine: "kaniko",
            dockerFilePath: "/Dockerfile-v14-alpine",
            dockerWorkDir: "/",
          },
        },
      },
    }
  );
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "service",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create combined service",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "service",
    health: healthCodes.IN_PROGRESS,
  });
  console.log("Combined service created");
  return data;
};

export const createPostgreSQL = async ({ projectName, apiClient }) => {
  const { data, error } = await callWithRetry(apiClient.create.addon, {
    parameters: {
      projectId: projectName,
    },
    data: {
      name: "PostgreSQL",
      description: "PostgreSQL Strapi Database",
      type: "postgres",
      version: POSTGRESQL_VERSION,
      tlsEnabled: true,
      billing: {
        deploymentPlan: NF_BASIC_PLAN,
        storage: 4096,
        replicas: 1,
      },
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "postgresql",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create PostgreSQL addon",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "postgresql",
    health: healthCodes.DEPLOYING,
  });
  console.log("PostgreSQL created");
  return data;
};

export const createMinIO = async ({ projectName, apiClient }) => {
  const { data, error } = await callWithRetry(apiClient.create.addon, {
    parameters: {
      projectId: projectName,
    },
    data: {
      name: "MinIO",
      description: "MinIO Strapi Storage",
      type: "minio",
      version: MINIO_VERSION,
      tlsEnabled: true,
      externalAccessEnabled: true,
      billing: {
        deploymentPlan: NF_BASIC_PLAN,
        storage: 4096,
        replicas: 1,
      },
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "minio",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create MinIO addon",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "minio",
    health: healthCodes.DEPLOYING,
  });
  console.log("MinIO created");
  return data;
};

export const addSubdomain = async ({ projectName, subdomain, apiClient }) => {
  let domainVerify;
  let attempts = 0;
  const addSubdomainToNorthflank = async () => {
    const { data, error } = await apiClient.add.domain.subdomain({
      parameters: {
        domain: DOMAIN_NAME,
      },
      data: {
        subdomain: subdomain,
      },
    });
    if (error) {
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "domain",
        health: error.status,
        message: error.message,
      });
      return {
        error: true,
        code: error.status,
        message: "Could not add subdomain",
        apiResponse: error.message,
      };
    }
    return data;
  };
  const verifySubdomainOnNorthflank = async () => {
    attempts = attempts + 1;
    const { data, error } = await apiClient.verify.subdomain({
      parameters: {
        domain: DOMAIN_NAME,
        subdomain: subdomain,
      },
    });
    if (error && attempts > 10) {
      clearInterval(domainVerify);
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "domain",
        health: error.status,
        message: error.message,
      });
      console.log("Error verifying domain");
      return error;
    } else if (data) {
      console.log("Domain verified");
      const servicePorts = await getServicePorts();
      await assignSubdomainToService({
        portId: servicePorts?.ports?.[0]?.name,
      });
      clearInterval(domainVerify);

      return data;
    }
  };
  const assignSubdomainToService = async ({ portId }) => {
    const { data, error } = await apiClient.assign.subdomain.service({
      parameters: {
        domain: DOMAIN_NAME,
        subdomain: subdomain,
      },
      data: {
        projectId: projectName,
        serviceId: SERVICE_NAME,
        portName: portId,
      },
    });
    if (error) {
      console.log(error);
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "domain",
        health: error.status,
        message: error.message,
      });
      if (error.status === 404)
        return await assignSubdomainToService({ portId });
      else
        return {
          error: true,
          code: error.status,
          message: "Could not assign subdomain to the service",
          apiResponse: error.message,
        };
    }
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "domain",
      health: healthCodes.SUCCESS,
    });
    return data;
  };
  const configureCloudflare = async ({
    recordType,
    recordName,
    recordContent,
  }) => {
    return await (
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
          },
          body: JSON.stringify({
            type: recordType,
            name: recordName,
            content: recordContent,
            ttl: 120,
          }),
        }
      )
    ).json();
  };
  const getServicePorts = async () => {
    const { data, error } = await apiClient.get.service.ports({
      parameters: {
        projectId: projectName,
        serviceId: "strapi",
      },
    });
    if (error) {
      console.log(error);
      return {
        error: true,
        code: error.status,
        message: "Could not fetch ports",
        apiResponse: error.message,
      };
    }
    return data;
  };

  const northflankSubdomain = await addSubdomainToNorthflank();

  if (!northflankSubdomain.error) {
    const cloudflareConfig = await configureCloudflare({
      recordType: northflankSubdomain.recordType,
      recordName: northflankSubdomain.fullName,
      recordContent: northflankSubdomain.content,
    });
    // const cloudflareConfig = { success: true }; // FOR testing failed verification
    if (cloudflareConfig.success) {
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "domain",
        health: healthCodes.VERIFYING,
      });
      domainVerify = setInterval(verifySubdomainOnNorthflank, 3000);
    } else {
      await MongoDbHandler.Projects.addNewResponse({
        projectName,
        key: "domain",
        health: 500,
        message: "Could not configure domain on Cloudflare",
      });
    }
    console.log("Domain added");
  }
  return northflankSubdomain;
};

export const checkServiceBuild = async ({
  projectName,
  apiClient,
  serviceId,
}) => {
  const { data } = await apiClient.get.service.builds({
    parameters: {
      projectId: projectName,
      serviceId: serviceId,
    },
  });
  return data?.builds?.[0]?.status;
};

export const checkServiceContainers = async ({
  projectName,
  apiClient,
  serviceId,
}) => {
  const { data, error } = await apiClient.get.service.containers({
    parameters: {
      projectId: projectName,
      serviceId: serviceId,
    },
  });
  return data?.pods?.[data.pods.length - 1]?.status;
};

export const getServiceDetails = async ({
  projectName,
  serviceId,
  apiClient,
}) => {
  const buildStatus = await checkServiceBuild({
    projectName,
    serviceId,
    apiClient,
  });
  const containerStatus = await checkServiceContainers({
    projectName,
    apiClient,
    serviceId,
  });
  if (containerStatus === "TASK_RUNNING") {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "service",
      health: healthCodes.SUCCESS,
    });
  }

  const { data, error } = await apiClient.get.service.details({
    parameters: {
      projectId: projectName,
      serviceId,
    },
  });
  if (error) {
    if (error.status === 404) {
      await MongoDbHandler.Projects.updateProjectWithServiceDetails({
        projectName,
        serviceDetails: {},
      });
    }
    return {
      error: true,
      code: error.status,
      message: "Could not get service details",
      apiResponse: error.message,
    };
  }
  data.buildStatus = buildStatus;
  data.containerStatus = containerStatus;
  await MongoDbHandler.Projects.updateProjectWithServiceDetails({
    projectName,
    serviceDetails: data,
  });
  return data;
};

export const getJobBuild = async ({ projectName, jobId, apiClient }) => {
  const { data, error } = await apiClient.get.job.builds({
    parameters: {
      projectId: projectName,
      jobId,
    },
  });
  const builds = data?.builds || [];
  return builds[0];
};

export const getMinioDetails = async ({ projectName, minioId, apiClient }) => {
  const { data, error } = await apiClient.get.addon.details({
    parameters: {
      projectId: projectName,
      addonId: minioId,
    },
  });
  if (error) {
    if (error.status === 404) {
      await MongoDbHandler.Projects.updateProjectWithMinioDetails({
        projectName,
        minioDetails: {},
      });
    }
    return {
      error: true,
      code: error.status,
      message: "Could not get addon details",
      apiResponse: error.message,
    };
  }
  if (data?.status === "running") {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "minio",
      health: healthCodes.SUCCESS,
    });
  }
  await MongoDbHandler.Projects.updateProjectWithMinioDetails({
    projectName,
    minioDetails: data,
  });
  return data;
};

export const getPostgresqlDetails = async ({
  projectName,
  postgresqlId,
  apiClient,
}) => {
  const { data, error } = await apiClient.get.addon.details({
    parameters: {
      projectId: projectName,
      addonId: postgresqlId,
    },
  });
  if (error) {
    if (error.status === 404) {
      await MongoDbHandler.Projects.updateProjectWithPostgresqlDetails({
        projectName,
        postgresqlDetails: {},
      });
    }
    return {
      error: true,
      code: error.status,
      message: "Could not get addon details",
      apiResponse: error.message,
    };
  }
  if (data?.status === "running") {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "postgresql",
      health: healthCodes.SUCCESS,
    });
  }
  await MongoDbHandler.Projects.updateProjectWithPostgresqlDetails({
    projectName,
    postgresqlDetails: data,
  });
  return data;
};

// TODO link port to port_external once that's added to connection details
export const createSecretGroup = async ({
  projectName,
  minio,
  postgresql,
  apiClient,
}) => {
  const { data, error } = await callWithRetry(apiClient.create.secret, {
    parameters: {
      projectId: projectName,
    },
    data: {
      name: "Strapi",
      description: "Secret group for Strapi",
      secretType: "environment",
      priority: 10,
      restrictions: {
        restricted: false,
      },
      addonDependencies: [
        {
          addonId: minio,
          keys: [
            {
              keyName: "MINIO_EXTERNAL_ENDPOINT",
              aliases: ["MINIO_ENDPOINT"],
            },
            {
              keyName: "host",
              aliases: ["MINIO_HOST"],
            },
            {
              keyName: "accessKey",
              aliases: ["MINIO_ACCESS_KEY"],
            },
            {
              keyName: "secretKey",
              aliases: ["MINIO_SECRET_KEY"],
            },
            {
              keyName: "tlsEnabled",
              aliases: ["MINIO_SSL"],
            },
          ],
        },
        {
          addonId: postgresql,
          keys: [
            {
              keyName: "host",
              aliases: ["DATABASE_HOST"],
            },
            {
              keyName: "port",
              aliases: ["DATABASE_PORT"],
            },
            {
              keyName: "username",
              aliases: ["DATABASE_USERNAME"],
            },
            {
              keyName: "password",
              aliases: ["DATABASE_PASSWORD"],
            },
            {
              keyName: "database",
              aliases: ["DATABASE_NAME"],
            },
          ],
        },
      ],
      data: {
        MINIO_BUCKET: "media",
        MINIO_FOLDER: "uploads",
      },
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "secrets",
      health: error.status,
      message: error.message,
    });
    return {
      error: true,
      code: error.status,
      message: "Could not create secret group",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "secrets",
    health: healthCodes.SUCCESS,
  });
  console.log("Secret group created");
  return data;
};

export const fetchPostgresqlCredentials = async ({
  projectName,
  addonId,
  apiClient,
}) => {
  const { data, error } = await apiClient.get.addon.credentials({
    parameters: {
      projectId: projectName,
      addonId: addonId,
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "fetchPostgresql",
      health: error.status,
      message: error.message,
    });

    return {
      error: true,
      code: error.status,
      message: "Could not fetch PostgreSQL credentials",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.updateProjectWithConnectionDetails({
    projectName,
    name: "postgresqlConnectionDetails",
    details: data,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "fetchPostgresql",
    health: healthCodes.SUCCESS,
  });
  console.log("PostgreSQL credentials fetched");
  return data;
};

export const fetchMinioCredentials = async ({
  projectName,
  addonId,
  apiClient,
}) => {
  const { data, error } = await apiClient.get.addon.credentials({
    parameters: {
      projectId: projectName,
      addonId: addonId,
    },
  });
  if (error) {
    await MongoDbHandler.Projects.addNewResponse({
      projectName,
      key: "fetchMinio",
      health: error.status,
      message: error.message,
    });

    return {
      error: true,
      code: error.status,
      message: "Could not fetch MinIO credentials",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.updateProjectWithConnectionDetails({
    projectName,
    name: "minioConnectionDetails",
    details: data,
  });
  await MongoDbHandler.Projects.addNewResponse({
    projectName,
    key: "fetchMinio",
    health: healthCodes.SUCCESS,
  });
  console.log("MinIO credentials fetched");
  return data;
};

export const backupAddon = async ({ projectName, addonId, apiClient }) => {
  const { data, error } = await apiClient.backup.addon({
    parameters: {
      projectId: projectName,
      addonId: addonId,
    },
    data: {
      name: `b-${Date.now()}`,
    },
  });
  if (error) {
    console.log(error);
    return {
      error: true,
      code: error.status,
      message: "Could not backup addon",
      apiResponse: error.message,
    };
  }
  console.log("Addon backed up");
  return data;
};

export const deleteAddonBackup = async ({
  projectName,
  addonId,
  backupId,
  apiClient,
}) => {
  const { data, error } = await apiClient.delete.backup({
    parameters: {
      projectId: projectName,
      addonId: addonId,
      backupId: backupId,
    },
  });
  if (error) {
    console.log(error);
    return {
      error: true,
      code: error.status,
      message: "Could not delete addon",
      apiResponse: error.message,
    };
  }
  console.log("Addon deleted");
  return data;
};

export const restoreAddonBackup = async ({
  projectName,
  addonId,
  backupId,
  apiClient,
}) => {
  const { data, error } = await apiClient.restore.addon.backup({
    parameters: {
      projectId: projectName,
      addonId: addonId,
      backupId: backupId,
    },
  });
  if (error) {
    console.log(error);
    return {
      error: true,
      code: error.status,
      message: "Could not restore addon from backup",
      apiResponse: error.message,
    };
  }
  console.log("Addon restored");
  return data;
};

export const getAddonBackups = async ({ projectName, addonId, apiClient }) => {
  const { data, error } = await apiClient.get.addon.backups({
    parameters: {
      projectId: projectName,
      addonId: addonId,
    },
  });
  if (error) {
    return {
      error: true,
      code: error.status,
      message: "Could not get addon backups",
      apiResponse: error.message,
    };
  }
  await MongoDbHandler.Projects.updateAddonBackups({
    projectName,
    data: data?.backups,
  });

  for (const backup of data?.backups) {
    const backupDetails = await apiClient.get.addon.backup.details({
      parameters: {
        projectId: projectName,
        addonId: addonId,
        backupId: backup?.id,
      },
    });

    await MongoDbHandler.Projects.updateAddonBackup({
      projectName,
      backupId: backup?.id,
      restores: backupDetails?.data?.restores,
    });
  }

  return data;
};
