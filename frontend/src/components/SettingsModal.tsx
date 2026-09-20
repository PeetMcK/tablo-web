import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  HardDrive,
  Lightbulb,
  Signal,
  Film,
  Volume2,
  CalendarClock,
  MapPin,
  Tv,
  Info,
} from "lucide-react";
import {
  api,
  type SettingsOverview,
  type LineupChannel,
  type HardDrive as HardDriveInfo,
} from "../api/tablo";

interface Props {
  onClose: () => void;
}

type InfoSettings = NonNullable<SettingsOverview["settings"]>;

/**
 * Device settings, reached from the gear in the app menu.
 *
 * One modal over the whole device settings surface (docs/tablo-api.md). Reads
 * fan in through `/api/settings/overview`; each section is tolerant of a null
 * slice and renders "unavailable" rather than blanking the modal. Writes that
 * the device has a verb for are immediate and optimistic — the device echoes
 * the full settings object on every PATCH, so state resyncs from the response.
 * Controls with no device verb (guide refresh, set-location) are present but
 * call a no-op route and say so, rather than being hidden.
 */
export function SettingsModal({ onClose }: Props) {
  const [overview, setOverview] = useState<SettingsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    let alive = true;
    api.settings
      .overview()
      .then((o) => {
        if (alive) setOverview(o);
      })
      .catch((e) => {
        if (alive) setLoadError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const settings = overview?.settings ?? null;

  /** Optimistically write one flat setting; resync from the device echo. */
  const writeInfo = useCallback(
    async (key: keyof InfoSettings, value: string | boolean) => {
      setOverview((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, [key]: value } } : prev,
      );
      try {
        const echo = (await api.settings.patchInfo(key, value)) as Partial<InfoSettings>;
        setOverview((prev) =>
          prev ? { ...prev, settings: { ...prev.settings, ...echo } } : prev,
        );
      } catch (e) {
        flash(e instanceof Error ? e.message : "The Tablo refused the change.");
        // Revert to the truth by re-reading.
        api.settings.overview().then((o) => setOverview(o)).catch(() => {});
      }
    },
    [flash],
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim backdrop-blur-sm p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-2xl shadow-shade"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-bold text-fg">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="-m-1 rounded-xl p-1 text-fg-muted transition hover:bg-fill-soft hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
          {loading && <p className="text-sm text-fg-muted">Loading…</p>}
          {loadError && (
            <p className="text-sm text-danger">
              Could not load settings: {loadError}
            </p>
          )}

          {!loading && !loadError && overview && (
            <>
              <StorageSection harddrives={overview.harddrives} />
              <DeviceSection settings={settings} onWrite={writeInfo} />
              <RecordingSection settings={settings} onWrite={writeInfo} />
              <AudioSection settings={settings} onWrite={writeInfo} />
              <GuideSection guide={overview.guide} onFlash={flash} />
              <LocationSection location={overview.location} onFlash={flash} />
              <ChannelsSection onFlash={flash} />
              <AboutSection
                server={overview.server}
                network={overview.network}
                onFlash={flash}
              />
            </>
          )}
        </div>

        {toast && (
          <div
            role="status"
            className="border-t border-border bg-fill-soft px-6 py-3 text-sm text-fg-secondary"
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Section scaffolding ---------------------------------------------------

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-fg-muted">
        <span className="text-fg-subtle" aria-hidden>
          {icon}
        </span>
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{label}</p>
        {hint && <p className="text-xs text-fg-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
        checked ? "bg-accent" : "bg-fill"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface-raised shadow transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-xl border border-border bg-fill-soft p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-1 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            value === o.value
              ? "bg-accent text-accent-fg"
              : "text-fg-secondary hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// --- Storage ---------------------------------------------------------------

function asDrives(hd: unknown): HardDriveInfo[] {
  if (Array.isArray(hd)) return hd as HardDriveInfo[];
  if (hd && typeof hd === "object") {
    const obj = hd as Record<string, unknown>;
    if (Array.isArray(obj.harddrives)) return obj.harddrives as HardDriveInfo[];
    if (Array.isArray(obj.drives)) return obj.drives as HardDriveInfo[];
    return [hd as HardDriveInfo];
  }
  return [];
}

function fmtGiB(mib?: number, bytes?: number): string | null {
  let gib: number | null = null;
  if (typeof mib === "number") gib = mib / 1024;
  else if (typeof bytes === "number") gib = bytes / 1024 ** 3;
  if (gib == null) return null;
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} TB` : `${Math.round(gib)} GB`;
}

function StorageSection({ harddrives }: { harddrives: unknown | null }) {
  const drives = asDrives(harddrives);
  return (
    <Section icon={<HardDrive className="h-4 w-4" />} title="Storage">
      {drives.length === 0 && (
        <p className="text-sm text-fg-muted">No drive information available.</p>
      )}
      {drives.map((d, i) => {
        const total = fmtGiB(d.size_mib, d.size);
        // The device reports used space as `usage`; `size` is the capacity.
        const usedMib = d.usage_mib;
        const usedBytes = d.usage;
        const used = fmtGiB(usedMib, usedBytes);
        const free = fmtGiB(d.free_mib, d.free);
        const hasBreakdown =
          (typeof usedBytes === "number" || typeof usedMib === "number") &&
          (typeof d.size === "number" || typeof d.size_mib === "number");
        const capMib = d.size_mib ?? (d.size ? d.size / 1024 ** 2 : undefined);
        const useMib = usedMib ?? (usedBytes ? usedBytes / 1024 ** 2 : undefined);
        const fillPct =
          hasBreakdown && capMib && useMib != null && capMib > 0
            ? Math.min(100, Math.round((useMib / capMib) * 100))
            : null;
        const label = d.name ?? d.kind ?? "Drive";
        return (
          <div key={i} className="rounded-xl border border-border-subtle p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-sm font-medium text-fg">
                {label}
                {d.connected === false && (
                  <span className="ml-2 text-xs text-danger">disconnected</span>
                )}
              </p>
              <p className="shrink-0 text-xs text-fg-muted">{total ?? "—"}</p>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-fill"
              role="img"
              aria-label={
                fillPct != null
                  ? `${fillPct}% used`
                  : `capacity ${total ?? "unknown"}`
              }
            >
              {fillPct != null && (
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${fillPct}%` }}
                />
              )}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              {fillPct != null
                ? `${used ?? `${fillPct}%`} used${free ? ` · ${free} free` : ""}`
                : "Free space not reported by the device."}
              {d.format_state &&
              !["formatted", "authorized"].includes(d.format_state)
                ? ` · ${d.format_state}`
                : ""}
            </p>
          </div>
        );
      })}
    </Section>
  );
}

// --- Device (LED / amplifier) ---------------------------------------------

function DeviceSection({
  settings,
  onWrite,
}: {
  settings: InfoSettings | null;
  onWrite: (k: keyof InfoSettings, v: string | boolean) => void;
}) {
  return (
    <Section icon={<Lightbulb className="h-4 w-4" />} title="Device">
      <Row label="Status light" hint="Front-panel LED brightness">
        <Segmented
          label="Status light"
          value={settings?.led as "on" | "dim" | "off" | undefined}
          options={[
            { value: "on", label: "On" },
            { value: "dim", label: "Dim" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => onWrite("led", v)}
        />
      </Row>
      <Row label="Tuner amplifier" hint="Boosts weak antenna signal">
        <Switch
          label="Tuner amplifier"
          checked={!!settings?.enable_amplifier}
          onChange={(v) => onWrite("enable_amplifier", v)}
        />
      </Row>
    </Section>
  );
}

// --- Recording -------------------------------------------------------------

function RecordingSection({
  settings,
  onWrite,
}: {
  settings: InfoSettings | null;
  onWrite: (k: keyof InfoSettings, v: string | boolean) => void;
}) {
  return (
    <Section icon={<Film className="h-4 w-4" />} title="Recording">
      <Row label="Skip duplicates" hint="Don't record repeats you already have">
        <Switch
          label="Skip duplicates"
          checked={!!settings?.exclude_duplicates}
          onChange={(v) => onWrite("exclude_duplicates", v)}
        />
      </Row>
      <Row
        label="Extend live recordings"
        hint="Pad the end so overruns aren't cut off"
      >
        <Switch
          label="Extend live recordings"
          checked={!!settings?.extend_live_recordings}
          onChange={(v) => onWrite("extend_live_recordings", v)}
        />
      </Row>
      <Row
        label="Auto-delete recordings"
        hint="Free space by removing the oldest when full"
      >
        <Switch
          label="Auto-delete recordings"
          checked={!!settings?.auto_delete_recordings}
          onChange={(v) => onWrite("auto_delete_recordings", v)}
        />
      </Row>
    </Section>
  );
}

// --- Audio -----------------------------------------------------------------

function AudioSection({
  settings,
  onWrite,
}: {
  settings: InfoSettings | null;
  onWrite: (k: keyof InfoSettings, v: string | boolean) => void;
}) {
  // The device stores this as `audio`: "ac3" = surround passthrough,
  // "aac" = downmix to stereo. The app calls the AAC side "Audio Compatibility
  // Mode" (for gear that can't play surround), so this is a switch, not a pair.
  const stereo = settings?.audio === "aac";
  return (
    <Section icon={<Volume2 className="h-4 w-4" />} title="Audio">
      <Row
        label="Audio compatibility mode"
        hint="Converts surround (AC-3) to stereo (AAC) for devices that can't play surround"
      >
        <Switch
          label="Audio compatibility mode"
          checked={stereo}
          onChange={(v) => onWrite("audio", v ? "aac" : "ac3")}
        />
      </Row>
    </Section>
  );
}

// --- Guide -----------------------------------------------------------------

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function GuideSection({
  guide,
  onFlash,
}: {
  guide: SettingsOverview["guide"];
  onFlash: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    try {
      const r = await api.settings.guideUpdate();
      onFlash(
        r.noop
          ? "Guide update isn't available yet — the device command hasn't been wired."
          : "Guide update started.",
      );
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Guide update failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section icon={<CalendarClock className="h-4 w-4" />} title="Guide">
      <Row
        label="Last updated"
        hint={
          guide?.limit ? `Data extends to ${fmtDate(guide.limit)}` : undefined
        }
      >
        <span className="text-sm text-fg-secondary">
          {fmtDate(guide?.last_update)}
        </span>
      </Row>
      {typeof guide?.download_progress === "number" &&
        guide.download_progress > 0 &&
        guide.download_progress < 1 && (
          <p className="text-xs text-fg-muted">
            Updating… {Math.round(guide.download_progress * 100)}%
          </p>
        )}
      <button
        onClick={update}
        disabled={busy}
        className="rounded-xl bg-fill-soft px-4 py-2 text-sm font-medium text-fg-secondary transition hover:bg-fill hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        {busy ? "Updating…" : "Update guide"}
      </button>
    </Section>
  );
}

// --- Location --------------------------------------------------------------

const POSTAL_RE = /^(\d{5}|[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d)$/;

function LocationSection({
  location,
  onFlash,
}: {
  location: SettingsOverview["location"];
  onFlash: (m: string) => void;
}) {
  const currentPostal =
    (location?.location?.["postal_code"] as string | undefined) ?? "";
  const [postal, setPostal] = useState(currentPostal);
  const [busy, setBusy] = useState(false);
  const valid = POSTAL_RE.test(postal.trim());
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.settings.setLocation(postal.trim());
      onFlash("Location saved — the device will rescan channels for the new area.");
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Could not save location.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section icon={<MapPin className="h-4 w-4" />} title="Location">
      <Row
        label="Region"
        hint={location?.state ? `Currently ${location.state}` : undefined}
      >
        <span className="text-sm text-fg-secondary">
          {(location?.location?.["city"] as string | undefined) ?? "—"}
        </span>
      </Row>
      <div className="flex items-center gap-2">
        <input
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          placeholder="US ZIP or CA postal code"
          aria-label="Postal code"
          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          onClick={save}
          disabled={busy || !valid}
          className="shrink-0 rounded-xl bg-fill-soft px-4 py-2 text-sm font-medium text-fg-secondary transition hover:bg-fill hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {postal.length > 0 && !valid && (
        <p className="text-xs text-danger">
          Enter a 5-digit ZIP or a Canadian postal code (A1A 1A1).
        </p>
      )}
    </Section>
  );
}

// --- Channels --------------------------------------------------------------

function ChannelsSection({ onFlash }: { onFlash: (m: string) => void }) {
  const [scanId, setScanId] = useState<string | null>(null);
  const [channels, setChannels] = useState<LineupChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanPct, setScanPct] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    api.settings
      .channels()
      .then((r) => {
        if (!alive) return;
        setScanId(r.scan_id);
        setChannels(r.channels);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (path: string) => {
    setChannels((cs) =>
      cs.map((c) => (c.path === path ? { ...c, selected: !c.selected } : c)),
    );
    setDirty(true);
  };

  const rescan = async () => {
    setScanning(true);
    setScanPct(0);
    setChannels([]);
    try {
      const start = await api.settings.startScan();
      const id = start.scan_id;
      setScanId(id);
      // Poll on a human interval; a tight loop can wedge the device. Read the
      // discovered set each tick so the list fills live as the device finds
      // channels — a slow fill, like the app, not one jump at the end.
      let completed = false;
      for (let i = 0; i < 150 && !completed; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await api.settings.scanStatus(id);
        setScanPct(Math.round((st.progress ?? 0) * 100));
        completed = st.completed;
        try {
          const disc = await api.settings.scanDiscovered(id);
          setChannels(disc.channels);
        } catch {
          // A single failed discovered-read mid-scan is not fatal; the next
          // tick tries again and the final read below is authoritative.
        }
      }
      const disc = await api.settings.scanDiscovered(id);
      setChannels(disc.channels);
      setDirty(true);
      onFlash(`Scan complete — ${disc.channels.length} channels found. Review and save.`);
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Channel scan failed.");
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    if (!scanId) return;
    setSaving(true);
    try {
      const keep = channels.filter((c) => c.selected).map((c) => c.path);
      await api.settings.commit(scanId, keep);
      setDirty(false);
      onFlash(`Saved — ${keep.length} channels kept.`);
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Could not save the lineup.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<Tv className="h-4 w-4" />} title="Channels">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-muted">
          {loading
            ? "Loading…"
            : scanning
              ? `Scanning… ${channels.length} found`
              : `${channels.filter((c) => c.selected).length} of ${channels.length} kept`}
        </p>
        <button
          onClick={rescan}
          disabled={scanning}
          className="rounded-xl bg-fill-soft px-3 py-1.5 text-sm font-medium text-fg-secondary transition hover:bg-fill hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          {scanning ? `Scanning… ${scanPct}%` : "Rescan"}
        </button>
      </div>

      {scanning && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-fill"
          role="progressbar"
          aria-label="Channel scan progress"
          aria-valuenow={scanPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${scanPct}%` }}
          />
        </div>
      )}

      {channels.length > 0 && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border-subtle p-2">
          {channels.map((c) => (
            <label
              key={c.path}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-fill-soft"
            >
              <input
                type="checkbox"
                checked={c.selected}
                onChange={() => toggle(c.path)}
                className="h-4 w-4 accent-accent"
              />
              <span className="flex items-center gap-1">
                <Signal
                  className={`h-3.5 w-3.5 ${
                    c.signal_state === "good" ? "text-success" : "text-fg-muted"
                  }`}
                  aria-hidden
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {c.call_sign ?? c.channel_identifier ?? c.path}
              </span>
              {c.resolution && (
                <span className="text-xs uppercase text-fg-muted">
                  {c.resolution.replace("hd_", "").replace("_", "")}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      <button
        onClick={save}
        disabled={saving || !dirty || !scanId}
        className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save lineup"}
      </button>
    </Section>
  );
}

// --- About -----------------------------------------------------------------

function AboutSection({
  server,
  network,
  onFlash,
}: {
  server: SettingsOverview["server"];
  network: SettingsOverview["network"];
  onFlash: (m: string) => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [busy, setBusy] = useState(false);
  const ip = network?.ip ?? server?.local_address ?? "—";
  const firmware = server?.version
    ? `${server.version}${server.build_number ? ` (${server.build_number})` : ""}`
    : "—";
  const dirty = name.trim() !== (server?.name ?? "") && name.trim().length > 0;

  const rename = async () => {
    if (!dirty) return;
    setBusy(true);
    try {
      await api.settings.rename(name.trim());
      onFlash("Device renamed.");
    } catch (e) {
      onFlash(e instanceof Error ? e.message : "Could not rename the device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={<Info className="h-4 w-4" />} title="About Tablo">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Device name"
          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          onClick={rename}
          disabled={busy || !dirty}
          className="shrink-0 rounded-xl bg-fill-soft px-4 py-2 text-sm font-medium text-fg-secondary transition hover:bg-fill hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          Rename
        </button>
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-muted">IP address</dt>
        <dd className="text-fg-secondary">{ip}</dd>
        <dt className="text-fg-muted">Serial</dt>
        <dd className="truncate text-fg-secondary">{server?.server_id ?? "—"}</dd>
        <dt className="text-fg-muted">Firmware</dt>
        <dd className="text-fg-secondary">{firmware}</dd>
        {server?.model?.tuners != null && (
          <>
            <dt className="text-fg-muted">Tuners</dt>
            <dd className="text-fg-secondary">{server.model.tuners}</dd>
          </>
        )}
      </dl>
    </Section>
  );
}
