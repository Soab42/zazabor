//! BlueZ over the system D-Bus, through GDBus (`gio`): the hands-free profile Zazabor registers
//! (`org.bluez.ProfileManager1.RegisterProfile`, exporting `org.bluez.Profile1`), the adapters and
//! paired phones (`org.freedesktop.DBus.ObjectManager`), and connecting a phone's hands-free link.
//!
//! The exported object and the signal watch dispatch on the GLib main context of the thread that
//! set them up; Zazabor sets them up from worker threads, which have none of their own, so they
//! run on the app's main loop. The handlers only hand work to other threads.

use std::collections::HashMap;
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::{Arc, Mutex, OnceLock};

use gio::glib::variant::{Handle, ObjectPath};
use gio::glib::{ToVariant, Variant};
use gio::prelude::*;

/// Hands-free unit (what Zazabor is).
pub const HFP_HF: &str = "0000111e-0000-1000-8000-00805f9b34fb";
/// Hands-free audio gateway (what a phone is).
pub const HFP_AG: &str = "0000111f-0000-1000-8000-00805f9b34fb";
/// Where Zazabor's `org.bluez.Profile1` lives.
pub const PROFILE_PATH: &str = "/dev/soab/zazabor/hfp";

const BLUEZ: &str = "org.bluez";
const TIMEOUT_MS: i32 = 25_000;

const PROFILE_XML: &str = r#"<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" name="device" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="fd_properties" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" name="device" direction="in"/>
    </method>
  </interface>
</node>"#;

fn bus() -> Result<&'static gio::DBusConnection, String> {
    static BUS: OnceLock<Result<gio::DBusConnection, String>> = OnceLock::new();
    BUS.get_or_init(|| gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE).map_err(|e| format!("No system D-Bus: {e}")))
        .as_ref()
        .map_err(Clone::clone)
}

/// A D-Bus error as the user should read it. GDBus writes a remote error as
/// "GDBus.Error:<name>: <message>".
fn readable(e: &gio::glib::Error) -> String {
    let text = e.message().to_string();
    let (remote, message) = match text.strip_prefix("GDBus.Error:").and_then(|rest| rest.split_once(": ")) {
        Some((name, message)) => (name.to_string(), message.to_string()),
        None => (String::new(), text),
    };
    match remote.as_str() {
        "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" => "Bluetooth isn't running on this PC.".into(),
        "org.bluez.Error.NotReady" => "Bluetooth is off.".into(),
        "org.bluez.Error.AlreadyConnected" => "The phone is already connected.".into(),
        "org.bluez.Error.InProgress" => "The phone is already connecting.".into(),
        "org.bluez.Error.AlreadyExists" => "Another program already offers the Bluetooth hands-free role.".into(),
        "org.bluez.Error.Failed" | "org.bluez.Error.NotAvailable" => format!("Bluetooth: {message}"),
        _ => message,
    }
}

fn call(path: &str, interface: &str, method: &str, args: Option<&Variant>) -> Result<Variant, String> {
    bus()?
        .call_sync(Some(BLUEZ), path, interface, method, args, None, gio::DBusCallFlags::NONE, TIMEOUT_MS, gio::Cancellable::NONE)
        .map_err(|e| readable(&e))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adapter {
    pub path: String,
    pub address: String,
    pub powered: bool,
    /// UUIDs of the profiles registered on this PC.
    pub uuids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub path: String,
    pub adapter: String,
    pub address: String,
    pub name: String,
    pub paired: bool,
    pub connected: bool,
    /// It offers the hands-free audio gateway: a phone Zazabor can take calls from.
    pub gateway: bool,
    /// BlueZ calls it a phone (icon or class).
    pub phone: bool,
}

impl Device {
    /// Worth listing for calls.
    pub fn is_phone(&self) -> bool {
        self.paired && (self.gateway || self.phone)
    }
}

/// The value under `key` in a string-keyed dictionary (`a{sv}`, `a{sa{sv}}`), unboxed.
fn lookup(dict: &Variant, key: &str) -> Option<Variant> {
    if !dict.is_container() {
        return None;
    }
    dict.iter().find(|entry| entry.child_value(0).str() == Some(key)).map(|entry| {
        let value = entry.child_value(1);
        // `a{sv}` values are boxed, `a{sa{sv}}` values aren't (as_variant on those trips a GLib assertion).
        if value.is_type(gio::glib::VariantTy::VARIANT) { value.as_variant().unwrap_or(value) } else { value }
    })
}

fn prop(props: &Variant, key: &str) -> Option<Variant> {
    lookup(props, key)
}

fn prop_str(props: &Variant, key: &str) -> Option<String> {
    prop(props, key).and_then(|v| v.str().map(str::to_string))
}

fn prop_bool(props: &Variant, key: &str) -> bool {
    prop(props, key).and_then(|v| v.get::<bool>()).unwrap_or(false)
}

fn prop_strs(props: &Variant, key: &str) -> Vec<String> {
    prop(props, key).and_then(|v| v.get::<Vec<String>>()).unwrap_or_default()
}

/// The adapters and devices in a `GetManagedObjects` answer (`(a{oa{sa{sv}}})`).
pub fn parse_objects(reply: &Variant) -> (Vec<Adapter>, Vec<Device>) {
    let objects = if reply.is_container() && reply.type_().is_tuple() { reply.child_value(0) } else { reply.clone() };
    let (mut adapters, mut devices) = (Vec::new(), Vec::new());
    for entry in objects.iter() {
        let path = entry.child_value(0).str().unwrap_or_default().to_string();
        let interfaces = entry.child_value(1);
        if let Some(a) = lookup(&interfaces, "org.bluez.Adapter1") {
            adapters.push(Adapter { path: path.clone(), address: prop_str(&a, "Address").unwrap_or_default(), powered: prop_bool(&a, "Powered"), uuids: prop_strs(&a, "UUIDs") });
        }
        if let Some(d) = lookup(&interfaces, "org.bluez.Device1") {
            let uuids = prop_strs(&d, "UUIDs");
            let class = prop(&d, "Class").and_then(|v| v.get::<u32>()).unwrap_or(0);
            let address = prop_str(&d, "Address").unwrap_or_default();
            devices.push(Device {
                path,
                adapter: prop(&d, "Adapter").and_then(|v| v.str().map(str::to_string)).unwrap_or_default(),
                name: prop_str(&d, "Alias").or_else(|| prop_str(&d, "Name")).unwrap_or_else(|| address.clone()),
                address,
                paired: prop_bool(&d, "Paired"),
                connected: prop_bool(&d, "Connected"),
                gateway: uuids.iter().any(|u| u.eq_ignore_ascii_case(HFP_AG)),
                phone: prop_str(&d, "Icon").is_some_and(|i| i.starts_with("phone")) || (class >> 8) & 0x1f == 0x02,
            });
        }
    }
    adapters.sort_by(|a, b| a.path.cmp(&b.path));
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (adapters, devices)
}

/// Every adapter and device BlueZ knows.
pub fn objects() -> Result<(Vec<Adapter>, Vec<Device>), String> {
    let reply = call("/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", None)?;
    Ok(parse_objects(&reply))
}

/// Someone (PipeWire) already registered the hands-free unit role on an adapter.
pub fn hf_taken(adapters: &[Adapter]) -> bool {
    adapters.iter().any(|a| a.uuids.iter().any(|u| u.eq_ignore_ascii_case(HFP_HF)))
}

/// What BlueZ asks of Zazabor's profile.
pub struct Handlers {
    /// A phone's hands-free link is up: its device path and the RFCOMM socket. An error turns
    /// the connection down.
    pub connect: Box<dyn Fn(String, OwnedFd) -> Result<(), String> + Send + Sync>,
    /// BlueZ wants the link to this device closed.
    pub disconnect: Box<dyn Fn(String) + Send + Sync>,
    /// BlueZ dropped the profile (it's shutting down).
    pub release: Box<dyn Fn() + Send + Sync>,
}

static REGISTRATION: Mutex<Option<gio::RegistrationId>> = Mutex::new(None);

fn handle(handlers: &Handlers, method: &str, params: &Variant, invocation: gio::DBusMethodInvocation) {
    match method {
        "NewConnection" => {
            let device = params.child_value(0).str().unwrap_or_default().to_string();
            let index = params.child_value(1).get::<Handle>().map(|h| h.0);
            let raw = index.and_then(|i| invocation.message().unix_fd_list().and_then(|list| list.get(i).ok()));
            let Some(raw) = raw else {
                return invocation.return_dbus_error("org.bluez.Error.InvalidArguments", "No socket came with the connection");
            };
            // SAFETY: g_unix_fd_list_get returns a duplicate that the caller owns.
            let fd = unsafe { OwnedFd::from_raw_fd(raw) };
            match (handlers.connect)(device, fd) {
                Ok(()) => invocation.return_value(None),
                Err(e) => invocation.return_dbus_error("org.bluez.Error.Rejected", &e),
            }
        }
        "RequestDisconnection" => {
            (handlers.disconnect)(params.child_value(0).str().unwrap_or_default().to_string());
            invocation.return_value(None);
        }
        "Release" => {
            (handlers.release)();
            invocation.return_value(None);
        }
        _ => invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "Unknown method"),
    }
}

/// Exports `org.bluez.Profile1` and registers the hands-free unit profile with BlueZ.
pub fn register(handlers: Handlers, features: u16) -> Result<(), String> {
    let bus = bus()?;
    let mut registration = REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    if registration.is_none() {
        let node = gio::DBusNodeInfo::for_xml(PROFILE_XML).map_err(|e| e.to_string())?;
        let interface = node.lookup_interface("org.bluez.Profile1").ok_or("No Profile1 interface")?;
        let handlers = Arc::new(handlers);
        let id = bus
            .register_object(
                PROFILE_PATH,
                &interface,
                move |_, _, _, _, method, params, invocation| handle(&handlers, method, &params, invocation),
                |_, _, _, _, _| ().to_variant(),
                |_, _, _, _, _, _| false,
            )
            .map_err(|e| format!("Couldn't offer the hands-free profile: {e}"))?;
        *registration = Some(id);
    }
    let mut options: HashMap<String, Variant> = HashMap::new();
    options.insert("Name".into(), "Zazabor Hands-Free".to_variant());
    options.insert("Version".into(), 0x0107u16.to_variant());
    options.insert("Features".into(), features.to_variant());
    options.insert("AutoConnect".into(), true.to_variant());
    let path = ObjectPath::try_from(PROFILE_PATH).map_err(|e| e.to_string())?;
    let args = (path, HFP_HF, options).to_variant();
    match call("/org/bluez", "org.bluez.ProfileManager1", "RegisterProfile", Some(&args)) {
        Ok(_) => Ok(()),
        Err(e) => {
            if let Some(id) = registration.take() {
                let _ = bus.unregister_object(id);
            }
            Err(e)
        }
    }
}

/// Unregisters the profile and stops exporting it.
pub fn unregister() {
    let Ok(bus) = bus() else { return };
    if let Ok(path) = ObjectPath::try_from(PROFILE_PATH) {
        let _ = call("/org/bluez", "org.bluez.ProfileManager1", "UnregisterProfile", Some(&(path,).to_variant()));
    }
    if let Some(id) = REGISTRATION.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = bus.unregister_object(id);
    }
}

/// Connects the phone's hands-free link (BlueZ then calls `NewConnection`).
pub fn connect(device_path: &str) -> Result<(), String> {
    call(device_path, "org.bluez.Device1", "ConnectProfile", Some(&(HFP_AG,).to_variant())).map(|_| ())
}

/// Disconnects the phone's hands-free link (the phone itself stays connected for anything else).
pub fn disconnect(device_path: &str) -> Result<(), String> {
    call(device_path, "org.bluez.Device1", "DisconnectProfile", Some(&(HFP_AG,).to_variant())).map(|_| ())
}

static WATCH: Mutex<Option<gio::SignalSubscriptionId>> = Mutex::new(None);

/// A BlueZ signal that changes what the page shows: a device or adapter came or went, or one's
/// pairing, connection, name or power changed.
pub fn relevant(signal: &str, params: &Variant) -> bool {
    match signal {
        "InterfacesAdded" | "InterfacesRemoved" => true,
        "PropertiesChanged" => {
            let interface = params.child_value(0);
            let changed = params.child_value(1);
            let keys: Vec<String> = changed.iter().filter_map(|e| e.child_value(0).str().map(str::to_string)).collect();
            match interface.str() {
                Some("org.bluez.Device1") => keys.iter().any(|k| matches!(k.as_str(), "Paired" | "Connected" | "Name" | "Alias" | "UUIDs" | "Trusted")),
                Some("org.bluez.Adapter1") => keys.iter().any(|k| k == "Powered"),
                _ => false,
            }
        }
        _ => false,
    }
}

/// Calls `on_change` whenever [`relevant`] says so, until [`unwatch`].
pub fn watch(on_change: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    let bus = bus()?;
    let mut watch = WATCH.lock().unwrap_or_else(|e| e.into_inner());
    if watch.is_some() {
        return Ok(());
    }
    let id = bus.signal_subscribe(Some(BLUEZ), None, None, None, None, gio::DBusSignalFlags::NONE, move |_, _, _, _, signal, params| {
        if relevant(signal, params) {
            on_change();
        }
    });
    *watch = Some(id);
    Ok(())
}

pub fn unwatch() {
    if let (Ok(bus), Some(id)) = (bus(), WATCH.lock().unwrap_or_else(|e| e.into_inner()).take()) {
        bus.signal_unsubscribe(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gio::glib::VariantTy;

    /// What `GetManagedObjects` looks like on a PC with one adapter, a phone and a headset.
    const OBJECTS: &str = r#"({
        objectpath '/org/bluez': {'org.bluez.AgentManager1': @a{sv} {}, 'org.bluez.ProfileManager1': {}},
        '/org/bluez/hci0': {'org.bluez.Adapter1': {'Address': <'70:1A:B8:14:E1:86'>, 'Powered': <true>,
            'UUIDs': <['0000111f-0000-1000-8000-00805f9b34fb', '0000111e-0000-1000-8000-00805f9b34fb']>}},
        '/org/bluez/hci0/dev_11_22_33_44_55_66': {'org.bluez.Device1': {'Address': <'11:22:33:44:55:66'>,
            'Name': <'Pixel 7'>, 'Alias': <'My Pixel'>, 'Paired': <true>, 'Connected': <true>, 'Icon': <'phone'>,
            'Class': <uint32 5898764>, 'Adapter': <objectpath '/org/bluez/hci0'>,
            'UUIDs': <['0000111f-0000-1000-8000-00805f9b34fb', '0000110a-0000-1000-8000-00805f9b34fb']>}},
        '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF': {'org.bluez.Device1': {'Address': <'AA:BB:CC:DD:EE:FF'>,
            'Name': <'Headset'>, 'Paired': <true>, 'Connected': <false>, 'Icon': <'audio-headset'>,
            'Adapter': <objectpath '/org/bluez/hci0'>, 'UUIDs': <['0000111e-0000-1000-8000-00805f9b34fb']>}},
        '/org/bluez/hci0/dev_00_00_00_00_00_01': {'org.bluez.Device1': {'Address': <'00:00:00:00:00:01'>,
            'Paired': <false>, 'Icon': <'phone'>, 'Adapter': <objectpath '/org/bluez/hci0'>}}
    },)"#;

    #[test]
    fn parses_managed_objects() {
        let reply = Variant::parse(Some(VariantTy::new("(a{oa{sa{sv}}})").unwrap()), OBJECTS).unwrap();
        let (adapters, devices) = parse_objects(&reply);
        assert_eq!(adapters.len(), 1);
        assert_eq!((adapters[0].address.as_str(), adapters[0].powered), ("70:1A:B8:14:E1:86", true));
        assert!(hf_taken(&adapters));
        let phones: Vec<&Device> = devices.iter().filter(|d| d.is_phone()).collect();
        assert_eq!(phones.len(), 1, "{devices:?}");
        let pixel = phones[0];
        assert_eq!(pixel.name, "My Pixel");
        assert_eq!(pixel.address, "11:22:33:44:55:66");
        assert_eq!(pixel.adapter, "/org/bluez/hci0");
        assert!(pixel.gateway && pixel.phone && pixel.connected);
        // The headset offers the hands-free *unit*, not the gateway.
        let headset = devices.iter().find(|d| d.name == "Headset").unwrap();
        assert!(!headset.gateway && !headset.is_phone());
        // An unpaired phone isn't listed; one with no name shows its address.
        assert!(devices.iter().any(|d| d.name == "00:00:00:00:00:01" && !d.is_phone()));
    }

    #[test]
    fn filters_signals() {
        let changed = |iface: &str, key: &str| Variant::parse(None, &format!("('{iface}', {{'{key}': <true>}}, @as [])")).unwrap();
        assert!(relevant("PropertiesChanged", &changed("org.bluez.Device1", "Connected")));
        assert!(!relevant("PropertiesChanged", &changed("org.bluez.Device1", "RSSI")));
        assert!(relevant("PropertiesChanged", &changed("org.bluez.Adapter1", "Powered")));
        assert!(!relevant("PropertiesChanged", &changed("org.bluez.MediaPlayer1", "Connected")));
        assert!(relevant("InterfacesAdded", &().to_variant()));
    }

    #[test]
    fn readable_errors() {
        let err = |m: &str| gio::glib::Error::new(gio::IOErrorEnum::DbusError, m);
        assert_eq!(readable(&err("GDBus.Error:org.bluez.Error.NotReady: Resource Not Ready")), "Bluetooth is off.");
        assert_eq!(readable(&err("GDBus.Error:org.bluez.Error.Failed: Protocol not available")), "Bluetooth: Protocol not available");
        assert_eq!(readable(&err("Timeout was reached")), "Timeout was reached");
    }

    #[test]
    fn profile_xml_parses() {
        let node = gio::DBusNodeInfo::for_xml(PROFILE_XML).unwrap();
        assert!(node.lookup_interface("org.bluez.Profile1").is_some());
    }
}
