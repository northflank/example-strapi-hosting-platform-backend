<h1>
Strapi.run Backend Service
</h1>

This service is used as a back-end server for the Strapi.run management plane.

It handles:

- Creation of new Strapi deployments created via the Next.js site
- Configuring default MinIO configurations
- Managing backups and restores for PostgreSQL databases
- Fetching statistics about the strapi/strapi repository using the GitHub API

When a new deployment is made, the service handles:

- Creation of a new service, job, PostgreSQL database and MinIO addon
- Adding and verifying custom domains to Northflank and CloudFlare
- Creation of a new secret group that links the PostgreSQL and MinIO connection details so the service can connect to them
- Fetching PostgreSQL and MinIO connection details so the user can view them on the relevant deployment page 
- Triggering the job to configure MinIO default settings (default bucket and policy)

Data is stored in a MongoDB running on Northflank. The server always updates the database and returns relevant data to the frontend.

**Limitations:**
- The server is relying on a continuously running instance for the duration of creating a new deployment. It periodically rechecks each status and decides which step to do next. This is limiting since if the server shuts down or goes into error state some deployments will return wrong statuses, such as an infite "In progress". To resolve this, another job could be created that would periodically refetch the data and update status codes accordingly. 
