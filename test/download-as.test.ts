import { jest } from "@jest/globals";
import { downloadAs } from "../app/utils";

test("browser backup download uses a blob for large data", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const create = jest.fn((_object: Blob | MediaSource) => "blob:test-backup");
  const revoke = jest.fn();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("backup.json");
    expect(this.href).toBe("blob:test-backup");
  });
  jest.useFakeTimers();
  try {
    await downloadAs("x".repeat(1024 * 1024), "backup.json");
    expect((create.mock.calls[0][0] as Blob).size).toBe(1024 * 1024);
    expect(click).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:test-backup");
  } finally {
    click.mockRestore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    jest.useRealTimers();
  }
});
