import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, afterEach, beforeEach, test, expect } from "vitest";
import { SettingsModal } from "../components/SettingsModal";
import { ChannelGrid } from "../components/ChannelGrid";
import { api, type SettingsOverview } from "../api/tablo";

afterEach(() => vi.restoreAllMocks());

const OVERVIEW: SettingsOverview = {
  server: {
    name: "Den Tablo",
    version: "2.2.58",
    build_number: "1",
    local_address: "172.16.16.121",
    server_id: "SID123",
    model: { name: "t4g4", tuners: 2 },
  },
  network: { ip: "172.16.16.121", connection: "ethernet", status: "online" },
  harddrives: {
    connected: true,
    kind: "external",
    size_mib: 500000,
    format_state: "formatted",
  },
  guide: {
    last_update: "2026-09-19T00:00:00Z",
    limit: "2026-10-01T00:00:00Z",
    guide_seeded: true,
  },
  location: { state: "OR", location: { postal_code: "97201", city: "Portland" } },
  settings: {
    led: "dim",
    enable_amplifier: true,
    exclude_duplicates: true,
    extend_live_recordings: true,
    auto_delete_recordings: false,
    audio: "ac3",
  },
  update: null,
};

beforeEach(() => {
  vi.spyOn(api.settings, "channels").mockResolvedValue({
    scan_id: "77",
    channels: [
      {
        path: "/channels/scans/discovered/1",
        call_sign: "KSPS",
        resolution: "hd_1080",
        selected: true,
        signal_state: "good",
      },
      {
        path: "/channels/scans/discovered/2",
        call_sign: "KREM",
        resolution: "hd_720",
        selected: false,
        signal_state: "good",
      },
    ],
  });
});

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsModal onClose={() => {}} />
    </QueryClientProvider>,
  );
}

test("renders device name and firmware from the overview", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  renderModal();
  await waitFor(() =>
    expect(screen.getByDisplayValue("Den Tablo")).toBeInTheDocument(),
  );
  expect(screen.getByText("2.2.58 (1)")).toBeInTheDocument();
  expect(screen.getByText("172.16.16.121")).toBeInTheDocument();
  expect(screen.getByText("SID123")).toBeInTheDocument();
});

test("amplifier switch patches enable_amplifier off", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const patch = vi
    .spyOn(api.settings, "patchInfo")
    .mockResolvedValue({ enable_amplifier: false });
  renderModal();
  const sw = await screen.findByRole("switch", { name: /amplifier/i });
  expect(sw).toHaveAttribute("aria-checked", "true");
  fireEvent.click(sw);
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("enable_amplifier", false),
  );
});

test("LED segmented control writes the chosen value", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const patch = vi.spyOn(api.settings, "patchInfo").mockResolvedValue({ led: "off" });
  renderModal();
  const off = await screen.findByRole("radio", { name: "Off" });
  fireEvent.click(off);
  await waitFor(() => expect(patch).toHaveBeenCalledWith("led", "off"));
});

test("audio toggle writes aac", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const patch = vi.spyOn(api.settings, "patchInfo").mockResolvedValue({ audio: "aac" });
  renderModal();
  const aac = await screen.findByRole("radio", { name: "AAC" });
  fireEvent.click(aac);
  await waitFor(() => expect(patch).toHaveBeenCalledWith("audio", "aac"));
});

test("guide update calls the no-op route and shows a note", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const patch = vi.spyOn(api.settings, "patchInfo");
  const gu = vi
    .spyOn(api.settings, "guideUpdate")
    .mockResolvedValue({ ok: false, noop: true, reason: "x" });
  renderModal();
  const btn = await screen.findByRole("button", { name: /update guide/i });
  fireEvent.click(btn);
  await waitFor(() => expect(gu).toHaveBeenCalled());
  expect(await screen.findByText(/isn't available yet/i)).toBeInTheDocument();
  expect(patch).not.toHaveBeenCalled();
});

test("renaming the device posts the new name", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const rename = vi.spyOn(api.settings, "rename").mockResolvedValue({});
  renderModal();
  const input = await screen.findByLabelText("Device name");
  fireEvent.change(input, { target: { value: "Living Room" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(rename).toHaveBeenCalledWith("Living Room"));
});

test("channel commit posts only the checked paths", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);
  const commit = vi
    .spyOn(api.settings, "commit")
    .mockResolvedValue({ ok: true, count: 1 });
  renderModal();
  // KSPS is checked, KREM is not. Toggle KREM on, then save → both kept.
  const kremRow = await screen.findByText("KREM");
  const checkbox = kremRow.parentElement?.querySelector(
    "input[type=checkbox]",
  ) as HTMLInputElement;
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: /save lineup/i }));
  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith("77", [
      "/channels/scans/discovered/1",
      "/channels/scans/discovered/2",
    ]),
  );
});

test("a null slice renders unavailable, not a crash", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue({
    ...OVERVIEW,
    harddrives: null,
  });
  renderModal();
  expect(
    await screen.findByText(/no drive information available/i),
  ).toBeInTheDocument();
});

test("storage bar reflects usage vs capacity from the device", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue({
    ...OVERVIEW,
    harddrives: [
      {
        name: "WD My Passport (500 GB)",
        connected: true,
        kind: "external",
        format_state: "authorized",
        size: 491074011136,
        size_mib: 468324,
        usage: 33567145984,
        usage_mib: 32012,
        free: 457506865152,
        free_mib: 436312,
      },
    ],
  });
  renderModal();
  // ~6.8% used → the bar's aria-label rounds to 7% used.
  expect(await screen.findByLabelText("7% used")).toBeInTheDocument();
  expect(screen.getByText(/WD My Passport/)).toBeInTheDocument();
});

test("the app menu gear opens the settings modal", async () => {
  window.history.replaceState(null, "", "#/live");
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true,
    email: "viewer@example.com",
    devices: [],
    active_sid: null,
    direct_origin: null,
  });
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {});
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
  vi.spyOn(api.settings, "overview").mockResolvedValue(OVERVIEW);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: /tablo-web menu/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  expect(
    await screen.findByRole("dialog", { name: "Settings" }),
  ).toBeInTheDocument();
});
