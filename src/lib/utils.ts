/**
 * Class-name merge helper used by shadcn/ui and AI Elements.
 *
 * `clsx` builds a single className string from mixed inputs;
 * `tailwind-merge` resolves conflicts (e.g. `p-2 p-4` → `p-4`).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
