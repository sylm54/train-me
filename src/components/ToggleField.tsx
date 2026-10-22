/**
 * Labelled boolean switch (checkbox row) shared by the Settings sections and
 * the onboarding wizard's subagent toggle.
 */

export function ToggleField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        // Accent the native checkbox with the app's pink; sized to match the
        // number inputs' visual weight.
        className="mt-0.5 h-4 w-4 accent-[var(--color-pink-400)]"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span className="block text-[11px] text-[var(--color-muted-foreground)] mt-0.5">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
