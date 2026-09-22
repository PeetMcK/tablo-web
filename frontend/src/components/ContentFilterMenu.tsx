import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { OptionMenu } from "./OptionMenu";

interface Props {
  value: ContentFilter;
  onChange: (next: ContentFilter) => void;
}

/**
 * The content filters, as one control. The only one — Live, Guide and Library
 * all use this, at every width.
 *
 * It began as the phone's answer to a row of eight chips that needed 810px and
 * overflowed: below that width they became this. The row is gone now. Eight
 * chips cost a full line of every page to say what the trigger says in 120px,
 * and offered eight decisions where there is one — so the narrow window's
 * answer turned out to be the right answer everywhere.
 *
 * The popover itself is `OptionMenu`, shared with the Library's sort and
 * grouping: two idioms for one job read as two unrelated things, which was the
 * argument for this shape in the first place.
 */
export function ContentFilterMenu({ value, onChange }: Props) {
  return (
    <OptionMenu
      label="Filter by content"
      options={CONTENT_FILTERS}
      value={value}
      onChange={onChange}
      /* Left-aligned: this sits at the left end of every toolbar that carries
         it, and a right-aligned panel would hang off the screen on a phone. */
      align="left"
    />
  );
}
