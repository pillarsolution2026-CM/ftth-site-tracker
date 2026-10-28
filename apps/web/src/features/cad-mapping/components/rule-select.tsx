import type { ChangeEvent } from 'react';

interface RuleSelectProps<V extends string> {
  id: string;
  /** Accessible name (the row is identified by it). */
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  disabled?: boolean;
  onChange: (value: V) => void;
}

/** Compact select for table rows. */
export function RuleSelect<V extends string>({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: RuleSelectProps<V>) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value as V)}
      className="min-h-11 rounded-md border border-(--color-border) bg-transparent px-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
