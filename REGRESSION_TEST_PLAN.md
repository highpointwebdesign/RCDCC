# Segment Workflow Regression Test Plan

## Overview
This tests the NEW Segment-based lights system (2.0) after removing legacy Light Groups editor.  
Expected outcome: All tests pass with Segment workflow functioning end-to-end.

---

## Test Environment Setup
- ✅ Build: `npm run build` (completed successfully)
- ✅ Deploy: `.\deployApp.cmd` (build successful, ADB device optional for this phase)
- ⏳ **Next:** Open app in browser or on device to run manual tests

---

## Core Regression Tests

### Test 1: Hardware Setup Card - LED Configuration
**Goal:** Verify master LED count and color order can be configured  
**Steps:**
1. Navigate to **Lighting** section
2. Locate **Hardware Setup** card
3. Set **Total LED Count** to 30
4. Verify value persists (check browser console or localStorage)
5. Change **LED Color Order** (e.g., GRB → RGB)
6. Verify no error toasts appear

**Expected Results:**
- ✅ LED count updates without error
- ✅ Color order changes persist
- ✅ No "Legacy group editor" messages appear
- ✅ No modal windows open

---

### Test 2: Segment Creation (Step 1)
**Goal:** Create a new lighting segment  
**Steps:**
1. Click **"Create New Segment"** or **Step 1** button
2. Enter segment name (e.g., "Front Lights")
3. Proceed to next step
4. Verify segment appears in list

**Expected Results:**
- ✅ Segment modal/wizard opens
- ✅ Segment name accepts input
- ✅ No errors on save
- ✅ Segment saved and listed

---

### Test 3: LED Assignment (Step 2 / Step 3)
**Goal:** Assign specific LEDs to a segment  
**Steps:**
1. Select an existing segment or create new one
2. In **LED Mapping** section, select LEDs to assign (e.g., LEDs 1-10)
3. Apply assignment
4. Verify LED count in segment shows correct number

**Expected Results:**
- ✅ LED grid/selector responds to clicks
- ✅ Selected LEDs highlight/show as assigned
- ✅ LED count updates
- ✅ No "Light Group" modal appears
- ✅ No crashes on large LED counts (>50)

---

### Test 4: Segment Color Selection (Step 2)
**Goal:** Set primary and secondary colors for segment  
**Steps:**
1. Select a segment
2. Click color picker for **Primary Color**
3. Choose a color (e.g., red)
4. Verify color displays in segment preview
5. For dual-color patterns, set **Secondary Color**
6. Verify both colors persist

**Expected Results:**
- ✅ Color picker opens
- ✅ Color selection updates UI
- ✅ Colors persist across actions
- ✅ No validation errors
- ✅ Secondary color field shows/hides based on pattern

---

### Test 5: Profile Look Controls - Brightness & Effects
**Goal:** Adjust brightness, effect type, intensity, and speed via Profile Look card  
**Steps:**
1. Navigate to **Profile Look** card
2. Adjust **Brightness** slider (0-100%)
3. Select **FX Effect** (e.g., Solid, Glitter, Police)
4. Adjust **Intensity** slider (if effect supports it)
5. Adjust **Speed** slider (if effect supports it)
6. Verify controls enable/disable based on selected effect

**Expected Results:**
- ✅ Sliders move smoothly
- ✅ Values update in real-time
- ✅ Controls enable/disable based on pattern selection
- ✅ No "Light Group" editor appears
- ✅ Preview updates (if hardware connected)

---

### Test 6: Segment Edit & Delete
**Goal:** Modify and delete existing segments  
**Steps:**
1. In segment list, click **Edit** for a segment
2. Change segment name or LED assignment
3. Save changes
4. Verify update succeeds
5. Click **Delete** on a segment
6. Confirm deletion in dialog
7. Verify segment removed from list

**Expected Results:**
- ✅ Edit wizard opens (not legacy modal)
- ✅ Changes persist on save
- ✅ Delete confirmation shows
- ✅ Segment removed after confirmation
- ✅ No crashes
- ✅ **CRITICAL:** No old "Light Group" modal appears

---

### Test 7: Lighting Profile Save & Load
**Goal:** Save a complete lighting configuration and restore it  
**Steps:**
1. Configure multiple segments with different colors/patterns
2. Click **Save as New Profile** in **Lighting Profiles** card
3. Enter profile name (e.g., "My Custom Setup")
4. Verify profile appears in saved list
5. Create/modify a second configuration
6. Click **Load** on the first saved profile
7. Verify all segments, colors, and settings restore

**Expected Results:**
- ✅ Profile saves without error
- ✅ Profile appears in list
- ✅ Load restores all segment settings
- ✅ No old "Light Group" data loads
- ✅ Profiles persist after refresh

---

### Test 8: Lighting Master Control (Lighting Enabled Toggle)
**Goal:** Toggle lighting system on/off via Hardware Setup card  
**Steps:**
1. In **Hardware Setup** card, toggle **Lighting Enabled** switch
2. Toggle ON → Verify system activates
3. Create or modify segments and colors
4. Observe LED preview updates (if hardware connected)
5. Toggle OFF → Verify all LEDs turn off

**Expected Results:**
- ✅ Toggle updates state
- ✅ State persists
- ✅ No error toasts
- ✅ Segments still editable when toggled on
- ✅ Hardware responds (if BLE connected)

---

### Test 9: BLE Communication (If Hardware Connected)
**Goal:** Verify lighting commands push to ESP32 hardware  
**Prerequisites:**
- Vehicle connected via Bluetooth
- ESP32 firmware running

**Steps:**
1. Connect to vehicle via BLE
2. Set up segments with colors
3. Click **Save** or **Apply** (hardware push should occur)
4. Monitor ESP32 serial output or visual LED feedback
5. Verify LEDs light with correct colors/patterns
6. Modify brightness/intensity slider
7. Verify hardware updates in real-time

**Expected Results:**
- ✅ Hardware receives segment configuration
- ✅ LEDs light correctly
- ✅ Real-time slider updates work
- ✅ No "Legacy group" commands sent
- ✅ Profile save/load pushes to hardware

---

### Test 10: Lock Controls (Advanced)
**Goal:** Verify lock/unlock functionality for Hardware Setup  
**Steps:**
1. In **Hardware Setup** card, click lock icon
2. Try to modify LED count or color order
3. Verify inputs are disabled with warning toast
4. Unlock controls
5. Verify inputs become editable again

**Expected Results:**
- ✅ Lock prevents modifications
- ✅ Unlock re-enables editing
- ✅ State persists across sessions
- ✅ No crashes

---

## Negative Tests (Error Handling)

### Test N1: No Segments Created
**Steps:**
1. Start with empty segment list
2. Try to save a lighting profile
3. Verify system handles gracefully

**Expected Results:**
- ✅ Either auto-creates default segment or shows helpful message
- ✅ No crashes

---

### Test N2: LED Count Edge Cases
**Steps:**
1. Set LED count to 0
2. Set LED count to MAX_LIGHTS_TOTAL_LEDS (check app constant)
3. Try to assign more LEDs than count allows
4. Set invalid value (text, negative)

**Expected Results:**
- ✅ All values clamped to valid range
- ✅ No crashes or console errors
- ✅ User receives clear error messages

---

### Test N3: Missing BLE Connection
**Steps:**
1. Disconnect all Bluetooth devices
2. Try to save/apply lighting changes
3. Observe app behavior

**Expected Results:**
- ✅ App either silently handles it or shows helpful message
- ✅ Segments remain editable locally
- ✅ Changes persist when device reconnects

---

## Verification Checklist

After all tests complete:
- [ ] No "Light Group" or "Manage Light Groups" text visible in UI
- [ ] No old Light Group editor modal appears
- [ ] No JavaScript console errors
- [ ] No browser warnings
- [ ] Segment workflow is intuitive and works end-to-end
- [ ] Hardware communication works (if BLE available)
- [ ] Profiles save/load correctly
- [ ] localStorage persists settings across refresh
- [ ] App remains responsive under all test conditions

---

## Success Criteria
✅ **PASS:** All tests 1-8 pass without errors  
✅ **PASS:** No legacy "Light Group" UI or modals appear  
✅ **PASS:** Segment workflow is the only active path  
✅ **PASS:** Ready for production deployment  

❌ **FAIL:** Any test fails or legacy UI appears → Requires follow-up  

---

## Next Steps After Testing

1. **If all pass:** Ready to commit and deploy to production
2. **If failures:** Investigate specific test, fix, re-run regression
3. **Optional cleanup:** Remove unused helper functions from app.js (future pass)

