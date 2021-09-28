import { ObjectId } from "mongodb";
import dotenv from "dotenv";
import healthCodes from "../healthCodes.js";
import slugify from "slugify";

dotenv.config();

const reservedSubdomains = ["api"];
const domainNameRegex = /^[a-zA-Z](-?[a-zA-Z0-9]+((-|\s)[a-zA-Z0-9]+)*)?$/; // Matches alphanumeric separated by spaces or hyphens, must start with a letter

export class Projects {
  constructor(db) {
    this.collection = db.collection("projects");
  }
  async startNewProject({ publicProjectName, attempt }) {
    let projectDomain = slugify(publicProjectName, {
      lower: true,
      remove: /[*+~.()'"!:@]/g,
      strict: true,
    }).substring(0, 20);
    if (!domainNameRegex.test(projectDomain)) {
      throw { error: true };
    }
    if (attempt > 0) {
      projectDomain = projectDomain + attempt.toString();
    } else {
      attempt = 1;
    }
    const existingProjects = await this.collection
      .find({
        projectDomain: projectDomain,
      })
      .toArray();
    if (
      existingProjects?.length === 0 ||
      reservedSubdomains.includes(projectDomain)
    ) {
      try {
        await this.collection.insertOne({
          projectName: projectDomain,
          publicProjectName: publicProjectName,
          projectDomain: projectDomain,
          progress: [
            {
              key: "project",
              step: "Project creation",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "service",
              step: "Combined service",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "domain",
              step: "Custom domain",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "job",
              step: "MinIO setup job",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "secrets",
              step: "Secrets configuration",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "fetchMinio",
              step: "Fetch MinIO connection details",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "fetchPostgresql",
              step: "Fetch PostgreSQL connection details",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "postgresql",
              step: "PostgreSQL addon",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "minio",
              step: "MinIO addon",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "bucketCreated",
              step: "MinIO bucket creation",
              health: healthCodes.NOT_STARTED,
            },
            {
              key: "bucketPolicy",
              step: "MinIO bucket policy configuration",
              health: healthCodes.NOT_STARTED,
            },
          ],
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        console.log(error);
        throw error;
      }
      return { success: true, slug: projectDomain };
    } else {
      return await this.startNewProject({
        publicProjectName,
        attempt: attempt + 1,
      });
    }
  }
  async addNewResponse({ projectName, key, health, message }) {
    try {
      await this.collection.updateOne(
        { projectName: projectName, "progress.key": key },
        {
          $set: {
            "progress.$.health": health,
            "progress.$.message": message,
          },
        }
      );
    } catch (error) {
      throw { success: false, error: error };
    }
    return { success: true };
  }
  async updateAddonBackups({ projectName, data }) {
    return await this.collection.updateOne(
      { projectName: projectName },
      {
        $set: {
          backups: data.reverse(),
        },
      }
    );
  }
  async updateAddonBackup({ projectName, backupId, restores }) {
    return await this.collection.updateOne(
      { projectName: projectName, "backups.id": backupId },
      {
        $set: {
          "backups.$.restores": Object.values(restores).reverse(),
        },
      }
    );
  }
  async updateProjectWithServiceDetails({ projectName, serviceDetails }) {
    return await this.collection.updateOne(
      { projectName: projectName },
      {
        $set: {
          serviceDetails: serviceDetails,
        },
      }
    );
  }
  async updateProjectWithMinioDetails({ projectName, minioDetails }) {
    return await this.collection.updateOne(
      { projectName: projectName },
      {
        $set: {
          minioDetails: minioDetails,
        },
      }
    );
  }
  async updateProjectWithConnectionDetails({ projectName, name, details }) {
    return await this.collection.updateOne(
      { projectName: projectName },
      {
        $set: {
          [name]: details,
        },
      }
    );
  }
  async updateProjectWithPostgresqlDetails({ projectName, postgresqlDetails }) {
    return await this.collection.updateOne(
      { projectName: projectName },
      {
        $set: {
          postgresqlDetails: postgresqlDetails,
        },
      }
    );
  }
  async fetchProject({ projectName }) {
    return await this.collection.findOne({ projectName: projectName });
  }
  async fetchProjects() {
    const result = this.collection.find().sort({ _id: -1 });
    return await result.toArray();
  }
}
