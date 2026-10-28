import { useUpdateStore } from "../app/store/update";

test("old update data preserves usage while the current build supplies the version", () => {
  const options = useUpdateStore.persist.getOptions();
  const legacy = {
    version: "1.0.0",
    versionType: "date",
    remoteVersion: "99.0.0",
    lastUpdate: 123,
    used: 4.5,
    subscription: 20,
    lastUpdateUsage: 456,
  };
  const current = { ...useUpdateStore.getState(), version: "2.16.1" };
  const merged = options.merge!(legacy, current);
  expect(merged.version).toBe("2.16.1");
  expect(merged.formatVersion(merged.version)).toBe("2.16.1");
  expect(merged.used).toBe(4.5);
  expect(merged.subscription).toBe(20);
  expect(merged.lastUpdateUsage).toBe(456);
  expect(merged).not.toHaveProperty("remoteVersion");
  expect(merged).not.toHaveProperty("lastUpdate");
  expect(merged).not.toHaveProperty("getLatestVersion");
  expect(options.merge!(undefined, current).version).toBe("2.16.1");
});
