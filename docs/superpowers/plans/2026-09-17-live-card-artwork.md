# Artwork on the Live card — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the series poster in the Live card's tile, fall back to the
channel logo where there is none, and replace the card's two-target hover with
a single dim carrying Play and Info.

**Architecture:** The guide record gains one nullable field,
`current_program.poster_image_id`, resolved from the SQLite mirror rather than
the device. The card reads it and picks poster or logo. The hover is rewritten
as one scrim over the whole card.

**Tech Stack:** FastAPI + SQLite mirror (backend), React + Tailwind (frontend),
pytest and vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-live-card-artwork-design.md`

## Global Constraints

- **Artwork is `thumbnail_image_id`**, 240×360, cropped 1:1 by dropping the
  bottom third (`object-position: 50% 0%`). Never `background_image`.
- **The plate is `bg-logo-plate`** — dark in both themes, as of `01006b5`.
  Poster and logo occupy an identical square.
- **A missing poster is normal, not an error.** ~18% of airings have none.
- **The mirror is the source**, never the device: there is no batch endpoint
  (`docs/tablo-api.md:133`), so per-channel device reads are not an option.
- **Both guide paths must carry the field** — `get_guide_data` and
  `stream_guide_data` — or posters appear only on a warm cache.
- Backend changes need `backend/run-native.sh` restarted by hand. Frontend
  changes need a rebuild; use the `tablo-stack` skill and run its checker.

---

### Task 1: The guide record carries a poster id

**Files:**
- Modify: `backend/app/state.py` (`_fetch_guide_enrichment` ~844,
  `get_guide_data` ~874, `stream_guide_data` ~958)
- Modify: `backend/app/store.py` (a path→image-id lookup)
- Test: `backend/tests/test_guide.py`

**Interfaces:**
- Consumes: `store.load_series(path)`, already used by `store.airing_detail`.
- Produces: `current_program["poster_image_id"]: int | None` on every channel
  record from both guide paths.

- [ ] **Step 1: Write the failing test**

```python
def test_current_programme_carries_its_series_poster(monkeypatch, mirror):
    """The tile's artwork must not cost a device round trip.

    Airing records carry `series_path` and never a `series` object - verified
    against the device on 30 of 30 sampled airings - so the poster is resolved
    from the mirror the guide sync already fills.
    """
    mirror.add_series(path="/guide/series/42", thumbnail_image_id=5007)
    ch = build_guide_channel(series_path="/guide/series/42")
    assert ch["current_program"]["poster_image_id"] == 5007


def test_a_programme_without_artwork_says_so_rather_than_failing():
    # ~18% of airings resolve to no thumbnail. The card reads None as
    # "show the channel logo", so this is the common path, not an error.
    ch = build_guide_channel(series_path="/guide/series/none")
    assert ch["current_program"]["poster_image_id"] is None
```

- [ ] **Step 2: Run them, watch them fail**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_guide.py -k poster -v`
Expected: FAIL — `KeyError: 'poster_image_id'`

- [ ] **Step 3: Keep `series_path` when building the airing**

In `_fetch_guide_enrichment`, the record `a` is discarded after six fields are
read off it. Add the seventh:

```python
channel_airing_map[c_path] = {
    "title": ad.get("show_title"),
    ...
    "series_path": a.get("series_path"),
}
```

- [ ] **Step 4: Resolve it, tolerantly**

```python
def poster_image_id(series_path: str | None) -> int | None:
    """The series poster for an airing, or None.

    None is the ordinary answer for roughly one airing in five - movies and
    sports are separate record types and carry no series row - so this must
    never raise into the guide.
    """
    if not series_path:
        return None
    try:
        row = load_series(series_path)
    except Exception:
        return None
    return (row or {}).get("thumbnail_image_id")
```

- [ ] **Step 5: Set it on both paths**

`get_guide_data` and `stream_guide_data` build `current_program` separately.
Both need the field, or the Live tab shows posters on a warm cache and logos
on a cold one.

- [ ] **Step 6: Run the suite, restart the backend, confirm against the device**

```bash
backend/.venv/bin/python -m pytest backend/tests -q
# restart backend/run-native.sh by hand - it does not reload
curl -s localhost:8000/api/channels | \
  python3 -c "import json,sys; d=json.load(sys.stdin); \
    p=[c for c in d if (c.get('current_program') or {}).get('poster_image_id')]; \
    print(f'{len(p)} of {len(d)} channels have a poster')"
```

Expected: a non-zero count well short of the total. Zero means the mirror
lookup is wrong; all of them means the fallback will never be exercised and
the number should be distrusted.

- [ ] **Step 7: Commit**

---

### Task 2: The tile shows the poster, or the logo

**Files:**
- Modify: `frontend/src/api/tablo.ts` (`Program`)
- Modify: `frontend/src/components/ChannelCard.tsx`
- Test: `frontend/src/__tests__/liveCard.test.tsx`

**Interfaces:**
- Consumes: `program.poster_image_id: number | null | undefined` from Task 1.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the series poster in the tile", () => {
  const { container } = render(
    <ChannelCard channel={channel({ current_program: program({ poster_image_id: 5007 }) })}
                 now={NOW} onPlay={() => {}} onInfo={() => {}} />);

  const art = container.querySelector("[data-plate] img")!;
  expect(art.getAttribute("src")).toBe("/api/channels/image/5007");
});

it("falls back to the channel logo when there is no poster", () => {
  // Roughly one airing in five. The logo is the empty state, not a failure.
  const { container } = render(
    <ChannelCard channel={channel({ current_program: program({ poster_image_id: null }) })}
                 now={NOW} onPlay={() => {}} onInfo={() => {}} />);

  expect(container.querySelector("[data-plate] img")).toBeNull();
  expect(screen.getByLabelText("PBS")).toBeInTheDocument();  // antenna/logo path
});
```

- [ ] **Step 2: Run them, watch them fail**

Run: `cd frontend && npx vitest run src/__tests__/liveCard.test.tsx`

- [ ] **Step 3: Add the field to `Program`**

```ts
/**
 * Series poster for what is airing, as a device image id.
 *
 * Null for roughly one airing in five - movies and sports are separate record
 * types with no series row - and the card shows the channel logo instead.
 */
poster_image_id?: number | null;
```

- [ ] **Step 4: Branch inside the plate**

The plate keeps its size, radius and `bg-logo-plate`. Only its contents change,
so a poster and a logo are the same square and a mixed column stays even.

```tsx
{posterId
  ? <img src={`/api/channels/image/${posterId}`} alt=""
         className="w-full h-full object-cover rounded-md" style={{ objectPosition: "50% 0%" }} />
  : <ChannelLogo src={channel.logo_url} callSign={channel.call_sign} className="w-8 h-8" />}
```

`object-position: 50% 0%` drops the poster's bottom third, which is what keeps
the title and the faces when a 2:3 image is cropped to 1:1.

- [ ] **Step 5: Run the tests. Commit**

---

### Task 3: One hover, one dim

**Files:**
- Modify: `frontend/src/components/ChannelCard.tsx`
- Test: `frontend/src/__tests__/liveCard.test.tsx`

**Interfaces:**
- Consumes: `onPlay`, `onInfo` — unchanged props.
- Produces: nothing other tasks read.

This task deletes more than it adds. Removing: `group/tile`, `group/body`, the
logo opacity crossfade, the triangle that replaced it, the synopsis contrast
drop, and the two press states. Their explanatory comments go with them — they
argue for a design that no longer exists, and leaving them is worse than having
no comment.

- [ ] **Step 1: Write the failing tests**

```tsx
it("dims the whole card on hover, not one half of it", () => {
  const { container } = render(<ChannelCard … />);

  const scrim = container.querySelector("[data-scrim]")!;
  // Over the card, not over the tile: `inset-0` on the card's own box.
  expect(scrim.className).toMatch(/\binset-0\b/);
  expect(container.querySelector(".group\\/tile")).toBeNull();
  expect(container.querySelector(".group\\/body")).toBeNull();
});

it("offers play and info as two real controls", () => {
  render(<ChannelCard … />);
  // Focusable and nameable without a pointer: hover may reveal them, but it
  // must not be what creates them. Touch has no hover at all.
  expect(screen.getByRole("button", { name: /Watch 7\.1 PBS/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /About First Civilizations/ })).toBeInTheDocument();
});

it("calls the right handler for each", async () => {
  const onPlay = vi.fn(), onInfo = vi.fn();
  render(<ChannelCard … onPlay={onPlay} onInfo={onInfo} />);

  fireEvent.click(screen.getByRole("button", { name: /Watch/ }));
  fireEvent.click(screen.getByRole("button", { name: /About/ }));
  expect(onPlay).toHaveBeenCalledTimes(1);
  expect(onInfo).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Rebuild the card**

The card is `relative group`. Inside it, after the content:

```tsx
<div data-scrim
     className="absolute inset-0 rounded-xl bg-shade/70 opacity-0
                group-hover:opacity-100 group-focus-within:opacity-100
                transition-opacity duration-150
                flex items-center justify-center gap-3
                motion-reduce:transition-none">
  <button onClick={onPlay} aria-label={`Watch ${label(channel)}`} …>…</button>
  <button onClick={onInfo} aria-label={`About ${program.title}`} …>…</button>
</div>
```

`group-focus-within` is not decoration: without it the controls are reachable
by keyboard but invisible while focused.

The scrim must be dark in both themes — the plate behind it is dark either way
(`01006b5`), and a light scrim would invert the card's relationship to its own
artwork.

- [ ] **Step 4: Handle coarse pointers**

Touch has no hover. Either the scrim is permanently visible under
`@media (pointer: coarse)`, or tapping the card reveals it. Pick one and say
which in a comment; a hover-only affordance is unreachable on a phone.

- [ ] **Step 5: Run the whole frontend suite**

Other tests address the old structure — `guideGrid.test.tsx` shares the plate
but not the hover, so failures there mean something was changed too widely.

Run: `cd frontend && npx vitest run && npx tsc -b`

- [ ] **Step 6: Commit**

---

### Task 4: Look at 28 of them

Not a code task, and the one that decides whether this ships.

- [ ] Build and deploy, then verify the stack:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
.claude/skills/tablo-stack/check-stack.sh        # must say "Stack is correct"
```

Run compose from the repo root. From a subdirectory the root `.env` does not
apply, the native overlay is skipped, and a container backend starts against a
different database — this happened once during this work.

- [ ] **Judge the column, not the card.** Six cards flatter any treatment;
  the question is whether 28 in a scrolling list read as information or as
  wallpaper.
- [ ] **Check a mixed row.** About one card in five shows a logo. The shared
  dark plate is what stops that looking broken; if it looks broken, that is
  the first thing to examine.
- [ ] **Check both themes**, and check the poster crop on a portrait-heavy
  poster — the bottom third is gone by design.
- [ ] **Check keyboard and touch.** Tab to a card: the scrim must appear and
  both controls must be reachable.

---

## Deferred, deliberately

- **Movie and sport artwork.** They are separate record types and would lift
  coverage above 82%. Out of scope; the fallback exists precisely so this is
  not urgent.
- **Guide and Library.** Live first, so the fallback rate is observed on real
  data before the same decision is made elsewhere.
- **The window treatment.** A 16:9 cover behind a variable aperture, which
  would also fix the cards being growers. Built as a mockup, not chosen —
  recorded in the artifact linked from the spec.
