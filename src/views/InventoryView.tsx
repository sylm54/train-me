/**
 * Inventory view: display + manage items and wishlist (backed by SQLite).
 *
 * Data lives in `<app_data>/agent_data/inventory.db` (inside the agent
 * sandbox) and is accessed via the `inventory_*` Tauri commands, which
 * route through the bash sandbox's embedded `sqlite` engine.
 *
 * Both the user (via this view) and the agent (via the `sqlite` builtin)
 * have full read/write access to both the `items` and `wishlist` tables.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  ShoppingBag,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriErrorToString } from "@/lib/types";
import { logActivity } from "@/lib/activity";
import { isAndroid } from "@/lib/export";

// ──────────────────────────────────────────────────────────────────────────
// Types (mirror Rust `InventoryItem` / `WishlistItem` in inventory.rs)
// ──────────────────────────────────────────────────────────────────────────

interface InventoryItem {
  id: number;
  name: string;
  category: string | null;
  quantity: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface WishlistItem {
  id: number;
  name: string;
  category: string | null;
  priority: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Result of the backend `inventory_export_csv` command. */
interface InventoryCsvExportResult {
  /** Number of data rows written. */
  files: number;
  /** Total bytes written. */
  bytes: number;
  /** Non-fatal warnings, one per line. */
  note: string | null;
}

/** Result of the backend `inventory_import_csv` command. */
interface InventoryCsvImportResult {
  items_added: number;
  items_updated: number;
  wishlist_added: number;
  wishlist_updated: number;
  note: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function priorityBadgeTone(p: string | null): {
  variant: "default" | "secondary" | "outline";
  className: string;
} {
  switch ((p ?? "").toLowerCase()) {
    case "high":
      return {
        variant: "default",
        className: "bg-[var(--color-pink-600)] text-white border-transparent",
      };
    case "medium":
      return {
        variant: "secondary",
        className:
          "bg-[var(--color-pink-100)] text-[var(--color-pink-700)] border-transparent",
      };
    case "low":
      return {
        variant: "outline",
        className:
          "text-[var(--color-muted-foreground)] border-[var(--color-border)]",
      };
    default:
      return {
        variant: "outline",
        className:
          "text-[var(--color-muted-foreground)] border-[var(--color-border)]",
      };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function InventoryView() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // CSV im/export state
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvStatus, setCsvStatus] = useState<
    | { kind: "ok"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [it, wl, cats] = await Promise.all([
        invoke<InventoryItem[]>("inventory_list_items"),
        invoke<WishlistItem[]>("inventory_list_wishlist"),
        invoke<string[]>("inventory_list_categories"),
      ]);
      setItems(it);
      setWishlist(wl);
      setCategories(cats);
    } catch (e) {
      setError(tauriErrorToString(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const addItem = useCallback(
    async (name: string, category: string, quantity: string, notes: string) => {
      const item = await invoke<InventoryItem>("inventory_add_item", {
        name,
        category: category || null,
        quantity: quantity ? parseInt(quantity, 10) : null,
        notes: notes || null,
      });
      await logActivity("inventory", "add_item", `#${item.id} ${item.name}`);
      await refresh();
    },
    [refresh],
  );

  const updateItem = useCallback(
    async (
      id: number,
      name: string,
      category: string,
      quantity: number,
      notes: string,
    ) => {
      await invoke("inventory_update_item", {
        id,
        name,
        category: category || null,
        quantity,
        notes: notes || null,
      });
      await logActivity("inventory", "update_item", `#${id} ${name}`);
      await refresh();
    },
    [refresh],
  );

  const removeItem = useCallback(
    async (id: number) => {
      await invoke("inventory_remove_item", { id });
      await logActivity("inventory", "remove_item", `#${id}`);
      await refresh();
    },
    [refresh],
  );

  const addWishlist = useCallback(
    async (name: string, category: string, priority: string, notes: string) => {
      const item = await invoke<WishlistItem>("inventory_add_wishlist_item", {
        name,
        category: category || null,
        priority: priority || null,
        notes: notes || null,
      });
      await logActivity(
        "inventory",
        "add_wishlist",
        `#${item.id} ${item.name}`,
      );
      await refresh();
    },
    [refresh],
  );

  const buyWishlistItem = useCallback(
    async (item: WishlistItem) => {
      await invoke<InventoryItem>("inventory_add_item", {
        name: item.name,
        category: item.category,
        quantity: 1,
        notes: item.notes,
      });
      await invoke("inventory_remove_wishlist_item", { id: item.id });
      await logActivity(
        "inventory",
        "buy_wishlist",
        `#${item.id} ${item.name}`,
      );
      await refresh();
    },
    [refresh],
  );

  /** Export both tables to a single CSV (type column distinguishes rows). */
  const exportCsv = useCallback(async () => {
    setCsvBusy(true);
    setCsvStatus(null);
    try {
      // Android: skip the save dialog (returns an unusable content:// URI) —
      // the backend writes to Downloads/train-me/ and shares instead.
      let target: string | null = null;
      if (!(await isAndroid())) {
        target = await saveDialog({
          defaultPath: "inventory.csv",
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
        if (!target) return; // user cancelled
      }
      const res = await invoke<InventoryCsvExportResult>(
        "inventory_export_csv",
        { outPath: target },
      );
      await logActivity("inventory", "export_csv", `${res.files} rows`);
      setCsvStatus({
        kind: "ok",
        text: `Exported ${res.files} row${res.files === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      setCsvStatus({ kind: "error", text: tauriErrorToString(e) });
    } finally {
      setCsvBusy(false);
    }
  }, []);

  /** Import (upsert) rows from a CSV previously produced by exportCsv. */
  const importCsv = useCallback(async () => {
    setCsvBusy(true);
    setCsvStatus(null);
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!selected) return; // user cancelled
      const path = typeof selected === "string" ? selected : selected[0];
      const res = await invoke<InventoryCsvImportResult>(
        "inventory_import_csv",
        { path },
      );
      await logActivity(
        "inventory",
        "import_csv",
        `+${res.items_added}~${res.items_updated} items, +${res.wishlist_added}~${res.wishlist_updated} wishlist`,
      );
      await refresh();
      setCsvStatus({
        kind: "ok",
        text:
          `Imported ${res.items_added + res.wishlist_added} new + ` +
          `${res.items_updated + res.wishlist_updated} updated.`,
      });
    } catch (e) {
      setCsvStatus({ kind: "error", text: tauriErrorToString(e) });
    } finally {
      setCsvBusy(false);
    }
  }, [refresh]);

  const busy = loading || refreshing || csvBusy;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Shared category autocomplete source: distinct categories already
          used across items + wishlist, so the category inputs can suggest
          them while still allowing free-text entry for new categories. */}
      <datalist id="inventory-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-[var(--color-pink-100)] grid place-items-center text-[var(--color-pink-600)]">
              <PackageOpen size={18} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Inventory
              </h1>
              <p className="text-xs text-[var(--color-muted-foreground)] mt-1">
                Import/export items & wishlist as CSV.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={busy || csvBusy}
            >
              {csvBusy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={importCsv}
              disabled={busy || csvBusy}
            >
              {csvBusy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Upload />
              )}
              <span className="hidden sm:inline">Import CSV</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={busy}
            >
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>
        </header>

        {csvStatus && !csvBusy && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
              csvStatus.kind === "ok"
                ? "border-[var(--color-success)] text-[var(--color-success)]"
                : "border-[var(--color-danger)] bg-[var(--color-pink-50)] text-[var(--color-danger)]"
            }`}
          >
            {csvStatus.kind === "ok" ? (
              <Check size={16} className="mt-0.5 shrink-0" />
            ) : (
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
            )}
            <span className="break-words">{csvStatus.text}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-pink-50)] p-3 text-sm text-[var(--color-danger)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn't load inventory</div>
              <div className="text-xs opacity-90 break-words">{error}</div>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)] py-12">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        )}

        {!loading && (
          <>
            <ItemsSection
              items={items}
              onAdd={addItem}
              onUpdate={updateItem}
              onRemove={removeItem}
              disabled={busy}
            />
            <WishlistSection
              wishlist={wishlist}
              onAdd={addWishlist}
              onBuy={buyWishlistItem}
              disabled={busy}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Items section
// ──────────────────────────────────────────────────────────────────────────

interface ItemsSectionProps {
  items: InventoryItem[];
  onAdd: (
    name: string,
    category: string,
    quantity: string,
    notes: string,
  ) => Promise<void>;
  onUpdate: (
    id: number,
    name: string,
    category: string,
    quantity: number,
    notes: string,
  ) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
  disabled: boolean;
}

function ItemsSection({
  items,
  onAdd,
  onUpdate,
  onRemove,
  disabled,
}: ItemsSectionProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0 flex items-baseline gap-2">
          <h2 className="text-base font-semibold">Items</h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {items.length} {items.length === 1 ? "row" : "rows"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAdd((v) => !v)}
          disabled={disabled}
        >
          <Plus />
          Add
        </Button>
      </header>

      <div className="p-4 space-y-3">
        {showAdd && (
          <AddItemForm
            onCancel={() => setShowAdd(false)}
            onSubmit={async (n, c, q, no) => {
              await onAdd(n, c, q, no);
              setShowAdd(false);
            }}
          />
        )}

        {items.length === 0 ? (
          <div className="text-center py-6 text-sm text-[var(--color-muted-foreground)]">
            No items yet. Click <strong>Add</strong> to create one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["Name", "Category", "Qty", "Notes", ""].map((h) => (
                    <th
                      key={h}
                      className="border-b border-[var(--color-border)] px-3 py-2 text-left font-medium text-[var(--color-muted-foreground)] whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, ri) => (
                  <tr
                    key={item.id}
                    className={
                      ri % 2 === 0
                        ? "bg-transparent"
                        : "bg-[var(--color-surface-muted)]"
                    }
                  >
                    {editing === item.id ? (
                      <EditItemRow
                        item={item}
                        onCancel={() => setEditing(null)}
                        onSubmit={async (n, c, q, no) => {
                          await onUpdate(item.id, n, c, q, no);
                          setEditing(null);
                        }}
                      />
                    ) : (
                      <>
                        <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap font-medium">
                          {item.name}
                        </td>
                        <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                          {item.category ?? "—"}
                        </td>
                        <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                          {item.quantity}
                        </td>
                        <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top max-w-md whitespace-normal">
                          {item.notes ?? ""}
                        </td>
                        <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => setEditing(item.id)}
                              disabled={disabled}
                              aria-label="Edit"
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                              onClick={() => onRemove(item.id)}
                              disabled={disabled}
                              aria-label="Remove"
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Wishlist section
// ──────────────────────────────────────────────────────────────────────────

interface WishlistSectionProps {
  wishlist: WishlistItem[];
  onAdd: (
    name: string,
    category: string,
    priority: string,
    notes: string,
  ) => Promise<void>;
  onBuy: (item: WishlistItem) => Promise<void>;
  disabled: boolean;
}

function WishlistSection({
  wishlist,
  onAdd,
  onBuy,
  disabled,
}: WishlistSectionProps) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <section className="border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-pink-50)]">
        <div className="min-w-0 flex items-baseline gap-2">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ShoppingBag size={14} />
            Wishlist
          </h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {wishlist.length} {wishlist.length === 1 ? "row" : "rows"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAdd((v) => !v)}
          disabled={disabled}
        >
          <Plus />
          Add
        </Button>
      </header>

      <div className="p-4 space-y-3">
        {showAdd && (
          <AddWishlistForm
            onCancel={() => setShowAdd(false)}
            onSubmit={async (n, c, p, no) => {
              await onAdd(n, c, p, no);
              setShowAdd(false);
            }}
          />
        )}

        {wishlist.length === 0 ? (
          <div className="text-center py-6 text-sm text-[var(--color-muted-foreground)]">
            No wishlist items yet. Click <strong>Add</strong> to create one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["Name", "Category", "Priority", "Notes", ""].map((h) => (
                    <th
                      key={h}
                      className="border-b border-[var(--color-border)] px-3 py-2 text-left font-medium text-[var(--color-muted-foreground)] whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wishlist.map((item, ri) => (
                  <tr
                    key={item.id}
                    className={
                      ri % 2 === 0
                        ? "bg-transparent"
                        : "bg-[var(--color-surface-muted)]"
                    }
                  >
                    <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap font-medium">
                      {item.name}
                    </td>
                    <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                      {item.category ?? "\u2014"}
                    </td>
                    <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                      <Badge {...priorityBadgeTone(item.priority)}>
                        {item.priority ?? "\u2014"}
                      </Badge>
                    </td>
                    <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top max-w-md whitespace-normal">
                      {item.notes ?? ""}
                    </td>
                    <td className="border-b border-[var(--color-border)] px-3 py-1.5 align-top whitespace-nowrap">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => onBuy(item)}
                        disabled={disabled}
                      >
                        <Check size={14} />
                        Bought
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Inline forms
// ──────────────────────────────────────────────────────────────────────────

interface AddItemFormProps {
  onCancel: () => void;
  onSubmit: (
    name: string,
    category: string,
    quantity: string,
    notes: string,
  ) => Promise<void>;
}

function AddItemForm({ onCancel, onSubmit }: AddItemFormProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(
        name.trim(),
        category.trim(),
        quantity.trim(),
        notes.trim(),
      );
    } catch (e) {
      setErr(tauriErrorToString(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-dashed border-[var(--color-border)] rounded-md p-3 space-y-2 bg-[var(--color-surface-muted)]">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_0.5fr] gap-2">
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <CategoryInput
          listId="inventory-categories"
          value={category}
          onChange={setCategory}
          disabled={busy}
        />
        <Input
          placeholder="Qty"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          disabled={busy}
          inputMode="numeric"
        />
      </div>
      <Input
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
      />
      {err && <div className="text-xs text-[var(--color-danger)]">{err}</div>}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

interface EditItemRowProps {
  item: InventoryItem;
  onCancel: () => void;
  onSubmit: (
    name: string,
    category: string,
    quantity: number,
    notes: string,
  ) => Promise<void>;
}

function EditItemRow({ item, onCancel, onSubmit }: EditItemRowProps) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category ?? "");
  const [quantity, setQuantity] = useState(item.quantity.toString());
  const [notes, setNotes] = useState(item.notes ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(
        name.trim() || item.name,
        category.trim(),
        Math.max(0, parseInt(quantity, 10) || 0),
        notes.trim(),
      );
    } catch {
      // surface via state if needed
    } finally {
      setBusy(false);
    }
  };

  return (
    <td colSpan={5} className="bg-[var(--color-surface-muted)] p-2">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_0.5fr] gap-2 mb-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="Name"
        />
        <CategoryInput
          listId="inventory-categories"
          value={category}
          onChange={setCategory}
          disabled={busy}
        />
        <Input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          disabled={busy}
          placeholder="Qty"
          inputMode="numeric"
        />
      </div>
      <Input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
        placeholder="Notes"
        className="mb-2"
      />
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </td>
  );
}

interface AddWishlistFormProps {
  onCancel: () => void;
  onSubmit: (
    name: string,
    category: string,
    priority: string,
    notes: string,
  ) => Promise<void>;
}

function AddWishlistForm({ onCancel, onSubmit }: AddWishlistFormProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(
        name.trim(),
        category.trim(),
        priority.trim(),
        notes.trim(),
      );
    } catch (e) {
      setErr(tauriErrorToString(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-dashed border-[var(--color-border)] rounded-md p-3 space-y-2 bg-[var(--color-surface-muted)]">
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr] gap-2">
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <CategoryInput
          listId="inventory-categories"
          value={category}
          onChange={setCategory}
          disabled={busy}
        />
        <Input
          placeholder="Priority (low/medium/high)"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          disabled={busy}
        />
      </div>
      <Input
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
      />
      {err && <div className="text-xs text-[var(--color-danger)]">{err}</div>}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Category autocomplete input
// ──────────────────────────────────────────────────────────────────────────

/**
 * A text input for the inventory category, backed by a shared `<datalist>`
 * (id `inventory-categories`) that's rendered once at the view root. The
 * datalist lets the browser autocomplete from previously-used categories
 * (distinct values across both `items` and `wishlist`); the field stays a
 * free-text input so new categories can still be typed.
 */
function CategoryInput({
  listId,
  value,
  onChange,
  disabled,
}: {
  listId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Input
      list={listId}
      placeholder="Category (optional)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}
