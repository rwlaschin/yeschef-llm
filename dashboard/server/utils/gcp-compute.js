import { InstancesClient, FirewallsClient, ZoneOperationsClient, GlobalOperationsClient } from "@google-cloud/compute";

const basename = (value = "") => value.split("/").pop() || "";
const ipOf = (instance) => instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || "";
const normalizeInstance = (instance, zone = basename(instance.zone)) => ({
  vm: instance.name,
  name: instance.name?.replace(/^yc-ollama-/, ""),
  zone,
  status: instance.status,
  machine: basename(instance.machineType),
  ip: ipOf(instance),
  createdAt: instance.creationTimestamp,
});

export const isStockoutError = (error) =>
  /ZONE_RESOURCE_POOL_EXHAUSTED|(?:state|sub-state)\s*:\s*STOCKOUT/i.test(error?.message || "");

export function createComputeAdapter({
  projectId,
  instancesClient,
  firewallsClient,
  InstancesClient: Instances = InstancesClient,
  FirewallsClient: Firewalls = FirewallsClient,
} = {}) {
  if (!instancesClient) instancesClient = new Instances({});
  if (!firewallsClient) firewallsClient = new Firewalls({});

  const wait = async (call, zone) => {
    const [operation] = await call;
    if (operation?.promise) return operation.promise();
    if (!operation?.name) return;
    const client = zone ? new ZoneOperationsClient({}) : new GlobalOperationsClient({});
    const [done] = await client.wait({ project: projectId, zone, operation: operation.name });
    if (done.error) throw new Error(done.error.errors?.map((error) => error.message).filter(Boolean).join("; ") || "Compute operation failed");
  };

  return {
    async checkAuth() {
      try {
        const token = await instancesClient.auth?.getAccessToken?.();
        if (!token) throw new Error("ADC could not mint an access token.");
        const account = projectId || await instancesClient.auth?.getProjectId?.();
        return { ok: true, account: account || "authenticated", error: null };
      } catch (error) {
        return { ok: false, account: null, error: error.message || String(error) };
      }
    },

    async listInstances() {
      const boxes = [];
      for await (const [zoneUrl, scoped] of instancesClient.aggregatedListAsync({ project: projectId })) {
        const zone = basename(zoneUrl);
        for (const instance of scoped.instances || []) {
          if (instance.labels?.purpose === "ollama-devbox") boxes.push(normalizeInstance(instance, zone));
        }
      }
      return boxes;
    },

    async getInstance({ name, zone }) {
      try {
        const [instance] = await instancesClient.get({ project: projectId, zone, instance: name });
        return normalizeInstance(instance, zone);
      } catch (error) {
        if (error.code === 404) return null;
        throw error;
      }
    },

    async createInstance({ zone, instanceResource }) {
      await wait(instancesClient.insert({ project: projectId, zone, instanceResource }), zone);
    },

    async deleteInstance({ name, zone }) {
      await wait(instancesClient.delete({ project: projectId, zone, instance: name }), zone);
    },

    async getFirewall(name) {
      try {
        const [firewall] = await firewallsClient.get({ project: projectId, firewall: name });
        return firewall;
      } catch (error) {
        if (error.code === 404) return null;
        throw error;
      }
    },

    async ensureFirewall({ name, port, tag, sourceRanges }) {
      const existing = await this.getFirewall(name);
      if (existing) {
        const allowed = new Set(existing.sourceRanges || []);
        const merged = [...allowed];
        for (const range of sourceRanges) {
          if (!allowed.has(range)) {
            allowed.add(range);
            merged.push(range);
          }
        }
        if (merged.length !== existing.sourceRanges?.length) {
          await wait(firewallsClient.patch({
            project: projectId,
            firewall: name,
            firewallResource: { sourceRanges: merged },
          }), null);
        }
        return;
      }
      await wait(firewallsClient.insert({
        project: projectId,
        firewallResource: {
          name,
          description: "Ollama devboxes — allowlist only; Ollama has no auth",
          direction: "INGRESS",
          sourceRanges,
          targetTags: [tag],
          allowed: [{ IPProtocol: "tcp", ports: [String(port)] }],
        },
      }), null);
    },
  };
}
