import { act, fireEvent, screen } from "@testing-library/react";
import { jest } from "@jest/globals";
import React from "react";

jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  Modal: (props: {
    title: string;
    children: React.ReactNode;
    actions: React.ReactNode[];
  }) => (
    <div>
      <h2>{props.title}</h2>
      {props.children}
      {props.actions}
    </div>
  ),
  showToast: jest.fn(),
  showConfirm: jest.fn(),
}));
const { default: Locale } = await import("../app/locales");
const { showBackupPassword } = await import("../app/components/backup-dialog");

test("export password dialog rejects an empty password and mismatched confirmation", async () => {
  let result!: Promise<string | null>;
  act(() => {
    result = showBackupPassword("export");
  });
  fireEvent.click(
    await screen.findByRole("button", { name: Locale.UI.Confirm }),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    Locale.Settings.Sync.PasswordEmpty,
  );
  fireEvent.change(screen.getByLabelText(Locale.Settings.Sync.Password), {
    target: { value: "密码!" },
  });
  fireEvent.change(
    screen.getByLabelText(Locale.Settings.Sync.ConfirmPassword),
    { target: { value: "other" } },
  );
  fireEvent.click(screen.getByRole("button", { name: Locale.UI.Confirm }));
  expect(screen.getByRole("alert").textContent).toBe(
    Locale.Settings.Sync.PasswordMismatch,
  );
  fireEvent.change(
    screen.getByLabelText(Locale.Settings.Sync.ConfirmPassword),
    { target: { value: "密码!" } },
  );
  fireEvent.click(screen.getByRole("button", { name: Locale.UI.Confirm }));
  await expect(result).resolves.toBe("密码!");
  expect(document.querySelector('input[type="password"]')).toBeNull();
});
