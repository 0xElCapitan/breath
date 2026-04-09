BREATH P0 — 2024 PM2.5 AQI Breakpoint Correction

Target file: src/processor/aqi.js
Test file: test/breath.test.js

OBJECTIVE
EPA’s current AQS breakpoint table uses the post-2024 PM2.5 AQI breakpoints.
BREATH’s PM25 breakpoint table is on the older regime. This is a correctness
bug that affects every PM2.5-derived AQI value in the construct.

Current EPA source of truth:
https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html

Scope is intentionally narrow:
- update PM25 breakpoints
- verify AQI calculation behavior for the new 501–999 extension
- update the Hazardous category comment
- add regression tests
- do not touch any other behavior, file, or parameter

======================================================================
TASK 1 — REPLACE BREAKPOINTS.PM25 WITH THE CURRENT EPA VALUES
======================================================================

In src/processor/aqi.js, replace the existing BREAKPOINTS.PM25 table with:

PM25: [
  [0.0,   9.0,   0,   50],    // Good
  [9.1,   35.4,  51,  100],   // Moderate
  [35.5,  55.4,  101, 150],   // USG
  [55.5,  125.4, 151, 200],   // Unhealthy
  [125.5, 225.4, 201, 300],   // Very Unhealthy
  [225.5, 325.4, 301, 500],   // Hazardous
  [325.5, 99999.9, 501, 999], // Beyond AQI / extreme events
],

Also update the JSDoc/comment immediately above BREAKPOINTS.PM25 so it clearly
states that this table reflects the current EPA PM2.5 AQI breakpoint regime and
cites the EPA AQS breakpoint table as source.

Required wording intent:
- mention the 2024 PM2.5 AQI revision
- include:
  Source: https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html

Do not change any non-PM25 breakpoint table.

======================================================================
TASK 2 — VERIFY calculateAQI HANDLES THE NEW 501–999 ROW CORRECTLY
======================================================================

Review calculateAQI in src/processor/aqi.js and verify it behaves correctly with
the new final PM25 row:

  [325.5, 99999.9, 501, 999]

Requirements:
- calculateAQI('PM25', 500) must return a finite integer
- calculateAQI('PM25', 1000) must return a finite integer
- no overflow
- no NaN / Infinity
- no category regression around AQI > 500

Important:
- do not rewrite calculateAQI unless an actual change is required
- if the existing implementation already handles the new row correctly, leave
  the logic alone
- if a minimal defensive change is required, keep it surgical and confined to
  src/processor/aqi.js

Also verify getCategory() still behaves correctly for AQI 501–999.
If the existing fallback already handles this correctly, do not change logic.
Only update comments if needed for clarity.

======================================================================
TASK 3 — UPDATE AQI_CATEGORIES HAZARDOUS COMMENT
======================================================================

Update the Hazardous category comment / documentation in src/processor/aqi.js
to reflect the new effective AQI span:

  { number: 6, name: 'Hazardous', range: [301, 999] }

If the code already uses a fallback for AQI > 500 and only the comment is stale,
change the comment only. Do not alter category-selection behavior unless needed
for correctness.

======================================================================
TASK 4 — ADD REGRESSION TESTS
======================================================================

In test/breath.test.js, add these tests to the existing
"AQI computation — breakpoints" suite:

  it('PM2.5 9.0 → AQI 50 (Good upper boundary)', ...)
  it('PM2.5 9.1 → AQI 51 (Moderate lower boundary)', ...)
  it('PM2.5 125.4 → AQI 200 (Unhealthy upper boundary)', ...)
  it('PM2.5 125.5 → AQI 201 (Very Unhealthy lower boundary)', ...)
  it('PM2.5 225.4 → AQI 300 (Very Unhealthy upper boundary)', ...)
  it('PM2.5 225.5 → AQI 301 (Hazardous lower boundary)', ...)

Also make the regression intent explicit in the older PM25 boundary coverage:
- annotate the existing 12.0 test with a note that it would have been the old
  Good upper boundary under the pre-2024 regime
- annotate the existing 150.4 test with a note that it would have been the old
  Unhealthy upper boundary under the pre-2024 regime

Do not remove useful legacy coverage unless the assertion itself is now wrong.
If an old assertion is invalid under the new EPA table, update it rather than
keeping a knowingly incorrect test.

======================================================================
VALIDATION / STOP CONDITIONS
======================================================================

Success means all of the following are true:

1. All pre-existing tests still pass
2. All 6 new PM25 breakpoint regression tests pass
3. calculateAQI('PM25', 500) returns a finite integer
4. calculateAQI('PM25', 1000) returns a finite integer
5. calculateAQI('PM25', 9.0) === 50
6. calculateAQI('PM25', 125.4) === 200
7. No non-PM25 breakpoint table changed
8. No file outside:
   - src/processor/aqi.js
   - test/breath.test.js
   was modified

======================================================================
HARD CONSTRAINTS
======================================================================

- Keep the change set minimal
- No refactors
- No formatting-only churn
- No behavioral changes outside PM2.5 AQI breakpoint correctness
- Do not touch any other file
- Do not change public API shape
- Do not introduce new dependencies

DELIVERABLE
Return:
1. a concise summary of exactly what changed
2. confirmation that the EPA PM25 rows now match the current source-of-truth table
3. the exact test results
4. any edge-case note discovered for AQI > 500