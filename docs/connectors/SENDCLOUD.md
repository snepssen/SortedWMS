# Sendcloud

Buy a shipping label for a packed order and keep the tracking number. Turn the module on under Modules. Open **Sendcloud**.

The public key, secret key and webhook secret are saved on this machine, in `sendcloud-secrets.json` next to the database. They are never shown again, never written into the journal, and never included in an export.

## What you need in Sendcloud

1. In Sendcloud, open Settings → Integrations and create an API public key and secret key. Paste each once into SortedWMS. A blank field later keeps the saved value.
2. Copy a shipping method id for each service you use (the number Sendcloud shows for that carrier and service).
3. Add a rule for each service: optional client, optional country (two letters, blank means any), a weight range in kilograms, the method id, and the carrier name. The closest rule wins: a client and a country beat a country, which beats a rule with neither.
4. Optional: a webhook for parcel status, posted to `https://<your-wms>/api/sendcloud/webhook`, signed with the integration secret. SortedWMS checks `Sendcloud-Signature` (hex HMAC-SHA256 of the raw body). A bad signature is refused. The same status sent twice is ignored.
5. For return labels, fill in the warehouse address that parcels come back to.

## A label

Pack the order and close the carton. The carton already has a weight and a size. Open Sendcloud, enter the order and the delivery address, and buy the label.

SortedWMS adds the carton weights and uses the carton size (one carton as it is; several cartons use the widest and the longest, and stack the heights). It asks Sendcloud for the label, saves the PDF next to the database under `sendcloud-labels/`, and puts a short tracking label on the existing print queue so a Zebra still prints something. The PDF is the carrier's label. The tracking number, carrier and tracking URL are stored on the order, so the delivery note shows them and a shop connector can send them when the order ships.

## Returns

When the Returns module is on, a booked return can have its own label. The customer address is where it is collected, and the saved warehouse address is where it is delivered. With Returns switched off, that button does nothing useful and the request is refused.

Errors stay on the Sendcloud page. If the Alerts module is on, the same text is raised there.
