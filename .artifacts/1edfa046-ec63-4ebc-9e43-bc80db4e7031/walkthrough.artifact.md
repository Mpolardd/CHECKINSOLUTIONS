# Walkthrough - Monthly vs Once-off Payments Support

I have updated the Women's Ministry Portal to support two types of funds: **Monthly** (Jan-Dec tracking) and **Once-off** (Special Contributions).

## Changes Made

### 1. New Fund Frequency
- When creating a "New Fund", you can now choose between:
    - **Monthly**: Uses the traditional 12-month grid (best for Dues/Welfare).
    - **Once-off**: Uses a simplified view (best for Special Seeds/Love Offerings).

### 2. Dynamic Table Layout
- **Monthly Funds**: The table remains in the 12-month (Jan-Dec) grid view.
- **Once-off Funds**: The 12-month columns are replaced by a **Progress Bar** and a **Total Contributed** column. This makes it much cleaner for items that are not recurring.

### 3. Simplified Payment Recording
- When recording a payment for a **Once-off** fund, the "Select Month" grid is automatically hidden. You simply enter the amount and save.

## How to verify

1. **Switch between Funds**:
   - Select "Women Monthly Dues" and see the 12-month grid.
   - Select "Women Contribution" (which is now Once-off) and see the progress bar view.

2. **Record a Contribution**:
   - Switch to "Women Contribution".
   - Click **+ Pay** for a sister.
   - Note that the month selection is gone. Enter an amount and save.

3. **Create a Custom Once-off Fund**:
   - Click **Add New Fund**.
   - Select "Once-off" as the frequency.
   - After creating, select it from the tabs and see the simplified view.

## Technical Details

> [!NOTE]
> The "Women Contribution" fund has been migrated to Once-off by default. Existing data is preserved and will show up in the "Total Contributed" view.
