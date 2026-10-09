# Demo and manual check: 9 October 2026

Scope: presentation-ready workflow demonstrator, not a production acceptance test or an approved warehouse SOP. All browser checks used synthetic stock.

## Guided workflows

Every action below was exercised through the guided page's controls, with the progress and error state checked after each action. All nine workflows completed: 156 guided actions in total.

| Scenario | Actions | Visible result |
| --- | --- | --- |
| Receiving to shipping | 22 | PRO-LATER shipped and traced to Fresh Market; PRO-EARLY remains blocked. |
| Auto-Shift & partitioning | 8 | Next-out yoghurt brought down, then relocated out of the changed partition. |
| Manual work & corrections | 17 | 4602 ready; 4601's pick follows the corrected location; displaced stock recovered. |
| Stock counts & accuracy | 9 | Three locations counted in six scans; two differences corrected; unknown-location list empty. |
| Temperature & quality holds | 12 | Eligible replacement stock allocated; follow-up and reasoned release retained. |
| Batch recall & traceability | 22 | Earlier recipient found; late receipt caught; independent temperature hold remains. |
| Physical quarantine & release | 13 | Scanned segregation and return; replacement stock used; quarantine position freed. |
| Trailer loading & dispatch | 27 | Wrong destination and incomplete departure rejected; unloading, review, reload and seal retained. |
| Trailer readiness & refrigeration | 26 | Missing, failed and expired checks stop progress; unloading remains possible; fresh checks and releases permit departure. |

These guided buttons issue demonstration commands. They are not evidence that a real scanner, printer, trailer or operator behaves the same way.

## Actual handheld and office screens

- On the browser-only free-play screens, selected `CMD-PICK`, scanned `O4502`, then completed pallet pickup, OUT-02 drop, pallet check and shipping-label confirmation. The office showed 4502 ready while 4501 remained open.
- Imported a synthetic Y1001 pallet at DOCK-IN using the office's Opening stock form. Selected `CMD-PUTAWAY`, scanned that pallet and confirmed the assigned AG07E2 drop. The handheld returned to choosing another pallet.
- Office category controls matched the handheld category. Browser printing remained simulated, not a physical label output.
- One fresh free-play load failed when the stock script was unavailable; reload recovered. Startup errors now appear visibly and disable work commands, with a regression test for failed initialization. This is error handling, not a claim of guaranteed network delivery.

## SOP and presenter guide

- Checked the SOP against dispatch selection, count planning limits, mode transitions, import validation and loading checks in the implementation.
- Corrected uncertain-network instructions, FEFO wording, urgency tie-breaking, count scope/accuracy, and unverified physical-key claims.
- Added complete manual pick and manual put-away procedures. Explained import loading-verification defaults, connection tokens, trailer versus product-temperature checks, and independent holds.
- Checked all contents anchors, role filters, All roles reset, direct links across a saved filter, and step numbers around an embedded table.
- Followed the presenter guide's manual-scenario link and checked scenario URL selection. All nine scenario links are tested; unknown scenario IDs fall back safely.
- Inspected desktop layout and a narrow mobile layout. Reference tables scroll within their container; the page itself has no horizontal overflow. The implementation review is folded below the procedures.
- Added print layout rules for the complete manual. A physical printout and generated PDF were not inspected in this check.

## Verification boundary

Run `npm test` for the regression suite and `npm run build:pages` to regenerate both `sop.html` and `demo.html`. The source remains editable in `docs/SOP.md` and `docs/DEMO.md`; generated site files are not committed.

The full regression suite passed all 205 tests in this check. The Pages build produced 16 entries, including the presenter guide and demo SOP.

Physical MC9401/DataWedge input, scan distance, glove use, real label printing, cold-store Wi-Fi and site timing remain unverified. This pass does not establish throughput savings, food-safety approval, role authorization or restart-safe scan deduplication. Those are outside this presentation's claim.
