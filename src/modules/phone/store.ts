import { numberKey, onPhone, phoneApi, type BtState, type Contact, type Events, type Phone, type PhoneState, type Transfer } from "./api";

/**
 * What the Phone section and the main window's call bar share: the link's state, the Bluetooth
 * calls, the transfers and each phone's contacts (for names). Loaded once per window, kept up to
 * date by the backend's events.
 */

type Topic = "state" | "bt" | "transfers" | "contacts";

let state: PhoneState | null = null;
/** Why the state couldn't be read (an older backend, or the app is locked). */
let stateError: string | null = null;
let bt: BtState | null = null;
const transfers = new Map<number, Transfer>();
const contacts = new Map<string, { list: Contact[]; byNumber: Map<string, Contact> }>();
const photos = new Map<string, Promise<string | null>>();
const subscribers = new Map<Topic, Set<() => void>>();
let started: Promise<void> | null = null;

function emit(topic: Topic) {
  for (const fn of subscribers.get(topic) ?? []) {
    try {
      fn();
    } catch (err) {
      console.warn("Phone:", err);
    }
  }
}

export function subscribe(topic: Topic, fn: () => void): () => void {
  let set = subscribers.get(topic);
  if (!set) subscribers.set(topic, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** Also lets a view hear raw events (a new text, a notification) without its own listener. */
const relays = new Map<keyof Events, Set<(payload: never) => void>>();
export function onEvent<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
  let set = relays.get(event);
  if (!set) relays.set(event, (set = new Set()));
  set.add(fn as (payload: never) => void);
  return () => set!.delete(fn as (payload: never) => void);
}
function relay<K extends keyof Events>(event: K, payload: Events[K]) {
  for (const fn of relays.get(event) ?? []) (fn as (payload: Events[K]) => void)(payload);
}

/** Loads everything and starts listening; safe to call many times. */
export function startStore(): Promise<void> {
  started ??= (async () => {
    const events: (keyof Events)[] = ["phone-changed", "phone-pair", "phone-sms", "phone-notif", "phone-notif-removed", "phone-transfer", "phone-bt", "phone-ring", "phone-call-state"];
    for (const event of events) {
      void onPhone(event, (payload) => {
        if (event === "phone-changed") setState(payload as PhoneState);
        else if (event === "phone-bt") setBt(payload as BtState);
        else if (event === "phone-transfer") {
          const t = payload as Transfer;
          transfers.set(t.id, t);
          emit("transfers");
        }
        relay(event, payload as never);
      }).catch(() => undefined);
    }
    await Promise.all([refreshState(), refreshBt(), refreshTransfers()]);
  })();
  return started;
}

export async function refreshState(): Promise<PhoneState | null> {
  try {
    setState(await phoneApi.state());
    stateError = null;
  } catch (err) {
    stateError = String(err);
    emit("state");
  }
  return state;
}

export async function refreshBt(): Promise<BtState | null> {
  try {
    setBt(await phoneApi.btState());
  } catch {
    // No Bluetooth side in this build: calls go through the phone app.
  }
  return bt;
}

async function refreshTransfers() {
  try {
    for (const t of await phoneApi.transfers()) transfers.set(t.id, t);
    emit("transfers");
  } catch {
    // nothing to show
  }
}

export function setState(next: PhoneState) {
  state = next;
  stateError = null;
  emit("state");
}

export function setBt(next: BtState) {
  bt = next;
  emit("bt");
}

export const getState = () => state;
export const getStateError = () => stateError;
export const getBt = () => bt;
export const getTransfers = () => [...transfers.values()].sort((a, b) => b.id - a.id);

/** Drops finished transfers from the tray. */
export function clearFinishedTransfers() {
  for (const [id, t] of transfers) if (t.state === "done" || t.state === "failed" || t.state === "cancelled") transfers.delete(id);
  emit("transfers");
}

export function phoneById(id: string | null | undefined): Phone | null {
  return state?.phones.find((p) => p.phoneId === id) ?? null;
}

/** The Bluetooth phone that carries calls now (connected over HFP), if any. */
export function callPhone() {
  return bt?.enabled ? bt.devices.find((d) => d.connected) ?? null : null;
}

// ---- contacts ---------------------------------------------------------------------------------

export async function loadContacts(phoneId: string, force = false): Promise<Contact[]> {
  const cached = contacts.get(phoneId);
  if (cached && !force) return cached.list;
  try {
    const list = (await phoneApi.contacts(phoneId)).sort((a, b) => a.name.localeCompare(b.name));
    const byNumber = new Map<string, Contact>();
    for (const c of list) for (const n of c.numbers) byNumber.set(numberKey(n.number), c);
    contacts.set(phoneId, { list, byNumber });
    emit("contacts");
    return list;
  } catch {
    return cached?.list ?? [];
  }
}

export const contactList = (phoneId: string) => contacts.get(phoneId)?.list ?? [];

export function contactFor(phoneId: string | null | undefined, number: string): Contact | null {
  if (!number) return null;
  const key = numberKey(number);
  if (phoneId) return contacts.get(phoneId)?.byNumber.get(key) ?? null;
  for (const c of contacts.values()) {
    const hit = c.byNumber.get(key);
    if (hit) return hit;
  }
  return null;
}

/** The contact's picture as a `data:` URL (asked once per contact). */
export function contactPhoto(phoneId: string, contact: Contact | null): Promise<string | null> {
  if (!contact?.hasPhoto) return Promise.resolve(null);
  const key = `${phoneId}|${contact.id}`;
  let pending = photos.get(key);
  if (!pending) {
    pending = phoneApi.contactPhoto(phoneId, contact.id).catch(() => null);
    photos.set(key, pending);
  }
  return pending;
}

/** The name to show for a number: the contact's, else the one given, else the number. */
export function displayFor(phoneId: string | null | undefined, number: string, name?: string | null): string {
  return contactFor(phoneId, number)?.name || name || number || "Unknown";
}
