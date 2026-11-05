# IoT Hardware Pilot — protocol and status

## STATUS: NOT PERFORMED

**No real industrial device has been connected.** No AHF, SVG or STATCOM has been
polled over Modbus by this gateway, and no register map has been verified against
a physical unit.

This is not a gap that can be closed by writing more code, so it is recorded here
as the blocking item it is rather than being absorbed into a percentage.

> **2026-09-15.** Everything around the pilot is now built and tested. The Modbus
> client path — which had never executed, because `modbus-serial` was an
> uninstalled optional dependency — is proven against a real Modbus TCP server;
> there is a commissioning tool that reads every register once and decodes it
> under all four conventions side by side; and the result is recorded in Pulse as
> evidence that cannot be self-certified. The pilot is now a two-hour field
> procedure with no engineering work in front of it. It has still not been run,
> and nothing here claims otherwise.

### What the simulator proves, and what it does not

`edge-gateway/sources/sim.mjs` exercises the transport, the spool, the retry
identity, the ingest validation and the alert engine end to end. That is genuinely
useful and it is how the 82 automated tests reach the whole pipeline.

It proves nothing about hardware. It cannot, because it never touches a register.
Specifically, these remain **unverified against any device**:

| Unknown | Why the simulator cannot answer it |
| --- | --- |
| Addressing mode (`one_based` vs `zero_based`) | The simulator has no registers. A wrong mode reads the neighbouring register — a valid-looking number from the wrong quantity. |
| Byte order within a word | Same. |
| Word order for 32-bit values (ABCD vs CDAB) | A float32 read with the words swapped is finite and plausible. `__tests__/modbus.decode.test.mjs` asserts this explicitly. |
| Scaling factor and offset per register | Vendor-specific; a factor-of-10 error looks like a different operating point. |
| Which metrics a given model actually publishes | The capability list on a profile is currently a template, not a measured fact. |
| Trip and status code meanings | Vendor code tables are not published in the profile. |
| Whether `ENERGY_KWH` is 16-, 32- or 64-bit, and where it rolls over | `energyDelta()` guesses from a list of common widths. On a real counter this must be configured, not inferred. |

Until a device is connected, the Modbus path is **PARTIAL**: the decoder supports
every convention and each convention is unit-tested against a known bit pattern,
but no evidence exists that a particular device is being read correctly.

---

## The pilot protocol

Run this once per model. It takes about two hours per unit.

### 1. Prepare

| Item | Value |
| --- | --- |
| Manufacturer | |
| Model | |
| Serial number | |
| Firmware version | |
| Register map document + version | |
| Rated output | |
| Site / panel | |
| Date, engineer | |

Reference instrument (a calibrated power-quality analyser or the customer's
metering) — model and calibration date:

### 2. Create the device profile

**In the application** (added 2026-09-15 — this previously required a SQL console,
which is not something to ask a commissioning engineer to do on site):

1. Open **IoT → Metric & Device Registry → Device profiles**.
2. Find the `GENERIC_<type>` template and press **Copy to company**.
3. Fill in manufacturer, model, firmware and register map version.
4. Set the three conventions that fail silently — addressing mode, byte order,
   word order — **from the device's register-map document, not from the
   defaults**. The form carries a warning at that exact point for this reason.
5. Select the **capabilities**: only the metrics this model actually publishes.
   A metric not listed is rejected for this device as `NOT_SUPPORTED_BY_PROFILE`
   rather than being stored as a number nobody can interpret.
6. Add one **register map** row per measurement: metric, documented address,
   holding/input, type, scale, offset. The editor refuses a metric that is not in
   the registry, a duplicate metric, a non-numeric address and an unknown type,
   so a map that saves is at least internally consistent.
7. Attach it to the device: **Fleet Monitor → device → profile**, or
   `PUT /iot/devices/:id/profile`.

The equivalent API calls are `POST /iot/profiles` and `PUT /iot/profiles/:id`;
shipped templates are read-only (`TEMPLATE_READONLY`) precisely so nobody edits a
generic profile into looking like a verified one.

### 3. Capture the raw reads

On the gateway, against the live device:

```bash
cd edge-gateway
npm i modbus-serial          # optional dependency; needed for a real device
node verify.mjs --config config.json --post
```

`verify.mjs` is **read-only** — it issues Modbus read function codes and cannot
write a register, which is not a property to leave to carefulness on a live
compensation unit.

It reads each register ONCE and decodes the same bytes under every convention at
the same time:

```
V_L1  documented 40001 · holding · float32 · scale 1 · V
  addressing    protocol  raw                  big/big     big/little    little/big  little/little
  one_based     0         0x43CF 0xC000          415.5       -2.0041       -2.0041        415.5
  zero_based    40001     error: Timed out
  -> read the device display for this quantity and find the matching column.
```

Read the device display and find the column that matches. That column is the
answer for **every** register at once, because a device uses one convention
throughout.

Three things to watch:

- **If two columns look plausible, check another register.** A voltage near 415 is
  easy to match by accident; a temperature or a power factor usually is not. Note
  above that `big/big` and `little/little` can agree on a float32 — a second
  register separates them.
- **If no column matches**, the documented address may be off (try the
  neighbouring register), the scale may be wrong (a factor of 10 or 1000 is the
  usual culprit), or the quantity may live in the other table.
- **The one_based/zero_based rows differ by one register.** If the neighbour
  returns what you expected from the target, the addressing mode is wrong even
  though the target "worked".

`--post` uploads the raw result to Pulse as a pilot in **`in_progress`**. The tool
cannot create a passed pilot: it has no standing to say a device reads correctly,
only that it answered.

### 4. Record what the device showed

In Pulse: **IoT → Hardware Pilots →** your pilot.

Enter, per register, what the DEVICE DISPLAY and the reference instrument showed
at the moment of the read. The difference and the verdict are **computed** from
those numbers — a register cannot be marked passed without a comparison inside
tolerance, and an attempt returns `NO_COMPARISON` with the actual difference.

Then confirm the three conventions and name the reference instrument and yourself.

**A pilot cannot be completed until all of that is present.** Three layers enforce
it: the button is disabled, the API returns `409 PILOT_INCOMPLETE` listing every
outstanding item, and a CHECK constraint on `iot_hardware_pilots` refuses the row.
A passing pilot then stamps the device profile as verified and corrects its
conventions to what you confirmed.

For the record, capture the same table on paper or in the pilot notes:

| Metric | Documented address | Protocol address used | Type | Raw registers (hex) | Decoded raw | Scale | Offset | Pulse value | Device display | Reference instrument | Difference | Within tolerance? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V_L1 | | | | | | | | | | | | |
| I_L1 | | | | | | | | | | | | |
| FREQUENCY | | | | | | | | | | | | |
| KW | | | | | | | | | | | | |
| PF | | | | | | | | | | | | |
| THD_I_L1 | | | | | | | | | | | | |
| TEMPERATURE | | | | | | | | | | | | |
| ENERGY_KWH | | | | | | | | | | | | |

**Suggested tolerances** (tighten per contract if the customer's spec is stricter):

| Quantity | Tolerance vs the reference |
| --- | --- |
| Voltage, current | ±0.5 % of reading |
| Frequency | ±0.02 Hz |
| Active / reactive / apparent power | ±1 % of reading |
| Power factor | ±0.01 absolute |
| THD | ±1 % absolute |
| Temperature | ±2 °C |
| Energy counter | ±0.5 % over a one-hour accumulation |

A register outside tolerance is a **failed** pilot for that metric. Do not ship
the metric with a note; remove it from the profile's capability list until the
mapping is corrected, so Pulse quarantines it as `NOT_SUPPORTED_BY_PROFILE`
instead of storing a wrong number.

### 5. Prove the decode conventions, not just the values

The trap is that a wrong convention often still produces a plausible number.
Confirm each explicitly:

1. **Addressing.** Read the register *below* and *above* the documented one. If
   the neighbour returns what you expected from the target, the addressing mode
   is wrong even though the target "worked".
2. **Word order.** For a float32, read it with `wordOrder: big` and `little` and
   compare both against the device display. Exactly one should match. If both
   look wrong, the byte order is also wrong.
3. **Sign.** Drive the unit into a leading-PF condition and confirm PF goes
   negative rather than staying positive. A sign convention silently dropped here
   makes every aggregate PF wrong in a way no range check can catch.
4. **Counter width.** Note the documented register width for `ENERGY_KWH` and
   record it, so the rollover detection in `ratios.js energyDelta()` is
   configured rather than guessed.

### 6. Prove the chain end to end

1. Start the gateway against the real device.
2. Confirm in Pulse: Fleet Monitor shows **Live**, the latest values carry the
   right units, and `data age` tracks the poll interval.
3. Pull the network cable for 10 minutes. Confirm: the queue grows, the spool file
   grows, the Gateway tab shows the queue depth, and **no telemetry is lost**.
4. Reconnect. Confirm the backlog drains, and confirm on the Data Quality page
   that `duplicate_samples` stays at 0 — or, if the gateway retried a committed
   batch, that the duplicates were absorbed rather than stored.
5. Force a genuine breach (or temporarily lower a threshold). Confirm: an
   incident opens, a ticket is raised, the technician appears on the alert, and
   the incident resolves when the condition clears.
6. Record the Modbus read latency and whether the configured poll interval is
   actually achievable: `actual_sampling_secs` on the device row versus
   `sampling_secs`.

### 7. Sign off

| | |
| --- | --- |
| Engineer | |
| Date | |
| Metrics passed | |
| Metrics failed / removed from the profile | |
| Profile code committed | |
| Notes | |

---

## Until this is done

- The Modbus source is marked **PARTIAL** in the certification matrix.
- The three shipped profiles are `is_template = TRUE` with an **empty register
  map** and no manufacturer or model, precisely so that nobody mistakes them for
  a verified mapping. The Device profiles list shows `none — cannot poll` against
  any profile with no map.
- The simulator prints `SIMULATOR SOURCE ACTIVE — values are synthetic and are NOT
  hardware evidence.` on every start.

## What is ready for the pilot

Everything except the device itself:

| Prerequisite | Status | Proof |
| --- | --- | --- |
| Decoder supports every addressing / byte / word convention | ✅ | 10 unit tests against known bit patterns |
| **The Modbus CLIENT path actually runs** | ✅ | 12 tests against a real Modbus TCP server — connect, holding + input reads, int16/int32/uint32/float32 over the wire, scale and offset |
| Commissioning tool | ✅ | `verify.mjs`, 5 tests driving it as a process |
| Register map enterable without SQL | ✅ | Metric & Device Registry → Device profiles |
| Register map validated on save | ✅ | unknown metric, duplicate, bad address or type refused |
| Metric registry to map registers onto | ✅ | 42 metrics, tenant overrides supported |
| Capability gating per model | ✅ | enforced at ingest |
| Partial read failure handled | ✅ | per-register `COMMUNICATION_ERROR` proven against a register that errors; the cycle is not discarded |
| Reconnect and recovery | ✅ | device taken offline mid-run and recovered, without a restart |
| Reconnect interval honoured | ✅ | a dead device is not hammered |
| Outage behaviour to test against | ✅ | durable spool, single-flight flush, dead-letter |
| Evidence recorded and un-fakeable | ✅ | `iot_hardware_pilots` + 16 tests + 13 end-to-end |

### What the Modbus integration tests prove, and what they do not

They run against a Modbus TCP server that answers correctly, so they prove the
client speaks the protocol properly. They say nothing about which convention a
PARTICULAR AHF uses, because that is a fact about a device, not about a protocol.
One of those tests asserts the point directly: the same registers read with the
wrong word order return a **finite, plausible, wrong** number, reported as
quality `VALID`, because nothing in the protocol says it is wrong.

The remaining unknown has changed size, not gone away:

| Before | After |
| --- | --- |
| The whole Modbus path is unexercised | The register map for this model is unverified |
