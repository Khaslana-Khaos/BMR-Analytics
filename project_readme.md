# Analytics Dashboard - Project Documentation

## Overview

This is a Next.js analytics dashboard that provides comprehensive e-commerce analytics including cart leak analysis, user behavior tracking, and product recommendations.

## API Endpoints

### `/api/data` - Analytics Data Endpoint

**Method:** GET  
**Description:** Returns comprehensive analytics data including cart leak analysis, user sessions, recommendations, and behavioral insights.

**Response Structure:**

```typescript
{
  sessions: Array<{
    sessionId: string;
    visitorId: string;
    country: string;
    ts: string;
    nView: number;
    nCartAdd: number;
    nCartRemove: number;
  }>;
  leak: {
    overall: number;
    items: Array<{
      item: string;        // Item ID
      adds: number;        // Number of times added to cart
      removes: number;     // Number of times removed from cart
      leak: number;        // Leak percentage (removes/adds)
    }>;
  };
  recos: Record<string, Array<{ item: string; score: number }>>;
  frequentBundles: Array<{ items: [string, string]; support: number }>;
  priceMarkov: Record<PriceTier, { pViewToCart: number; pCartToCheckout: number }>;
  priceMarkovMeta: { tLow: number | null; tHigh: number | null; min: number; max: number };
  priceBands: { bands: Array<{ name: PriceTier | 'All'; min: number; max: number; viewToCart: number; wishToCart: number; nView: number; nWish: number }> };
  priceRangeData: { viewFromPrices: number[]; viewToCartFromPrices: number[]; cartAddPrices: number[]; cartRemovePrices: number[] };
  categoryInteractions: Array<{ category: string; views: number; carts: number; wish: number; total: number }>;
  transitions: { states: string[]; counts: number[][]; probs: number[][] };
  sankey: { nodes: string[]; links: Array<{ source: number; target: number; value: number }> };
  daily: { series: Array<{ date: string; views: number; carts: number }>; anomaly: { hasThresholds: boolean; lower: number; upper: number; outliers: string[] } };
  geoInsights: Array<{ country: string; conversionRate: number }>;
  itemMeta: Record<string, { title: string; price: number; category: string; brand: string }>;
  __version: string;
}
```

## Cart Leak Analysis

### Overview

The cart leak analysis tracks items that are added to cart but then removed, providing insights into which product categories have the highest abandonment rates.

### Data Processing

1. **Item-Level Tracking**: Cart events are tracked at the individual item level (by item ID)
2. **Category Grouping**: Items are grouped by their product category for display
3. **Other Category**: Items without categories or with missing category data are grouped under "Other"
4. **Top 10 Display**: Only the top 10 categories with highest leak rates are shown

### Key Metrics

- **Adds**: Total number of times items in this category were added to cart
- **Removes**: Total number of times items in this category were removed from cart
- **Leak**: Percentage of adds that resulted in removes (removes/adds \* 100)

### Usage in Components

The `CartLeakByCategory` component in `components/AnalyticsDashboard.tsx` processes the leak data:

- Groups individual item leak data by category
- Combines uncategorized items into "Other" category
- Sorts by leak percentage (highest first)
- Displays top 10 categories with item counts

### Database Collections

- **Tracking Collection**: `customer_tracking_synthetic` (configurable via `TRACKING_COLLECTION` env var)
- **Listings Collection**: `listing` (configurable via `LISTINGS_COLLECTION` env var)
- **Categories Collection**: `productcategories` (configurable via `PRODUCT_CATEGORIES_COLLECTION` env var)

## Environment Variables

- `MONGODB_URI`: MongoDB connection string
- `TRACKING_COLLECTION`: Name of tracking data collection (default: "customer_tracking_synthetic")
- `LISTINGS_COLLECTION`: Name of product listings collection (default: "listing")
- `PRODUCT_CATEGORIES_COLLECTION`: Name of product categories collection (default: "productcategories")

## Date Filtering

### Global Date Range Filter

The dashboard now includes a global date range filter that affects all analytics and charts:

- **Location**: Top section of the dashboard, below the header
- **Functionality**: Filters sessions by date range and recalculates analytics
- **Affected Components**: All charts and summary statistics
- **Default Range**: Current month (if data available) or full data range

### Components

#### `AnalyticsDashboard`

- **File**: `components/AnalyticsDashboard.tsx`
- **Purpose**: Main dashboard wrapper with global date filtering
- **Features**:
  - Date range selection (from/to inputs)
  - Real-time filtering of sessions and daily data
  - Updated summary statistics based on filtered data
  - Consistent date filtering across all charts

#### `DateFilter` (Reusable Component)

- **File**: `components/DateFilter.tsx`
- **Purpose**: Reusable date filtering component
- **Features**:
  - Date range inputs with validation
  - Apply/Reset functionality
  - Callback-based data filtering
  - Responsive design

### Data Filtering Logic

1. **Session Filtering**: Sessions are filtered by their timestamp (`ts` field)
2. **Daily Data**: Daily series data is filtered by date range
3. **Statistics**: Summary statistics are recalculated based on filtered sessions
4. **Price Analytics**: Price range data, price bands, and price Markov data are scaled proportionally
5. **Behavioral Analytics**: Transition matrices and Sankey flow data are scaled proportionally based on session ratio
6. **Category Analytics**: Category interactions and cart leak data are recalculated consistently using the same session totals
7. **Recommendations**: Item recommendations and frequent bundles are maintained with filtered context
8. **Empty State Handling**: When no sessions exist in date range, all components show appropriate empty states

### Usage

Users can:

- Select custom date ranges using the date inputs
- Click "Apply Date Range" button to recalculate all analytics for the selected period
- See which date range is currently applied in the filter section
- Use "Reset to Current Month" to quickly return to default range
- Filter data to focus on specific time periods
- View session counts and metrics for the applied date range

### Apply Button Functionality

- **Manual Control**: Users must click "Apply Date Range" to trigger data recalculation
- **Current Range Display**: Shows exactly which date range is currently applied to all analytics
- **Performance**: Prevents unnecessary recalculations while users are selecting dates
- **Clear Feedback**: Visual indication of applied vs. selected date ranges
- **Date Validation**: Comprehensive validation prevents invalid date ranges:
  - End date before start date
  - Invalid dates like September 31st (September only has 30 days)
  - Invalid months (outside 1-12 range)
  - Invalid days for specific months (accounts for leap years)
- **Error Handling**: Clear error messages and disabled Apply button for invalid ranges

### Component Controls

Several components now include dropdown controls to limit the number of items displayed:

#### Cart Leak by Category

- **Top Count Control**: Dropdown to show top 5, 10, 15, 20, 25, or 50 categories
- **Dynamic Display**: Shows "Showing top X of Y categories"
- **Sorted by Leak Rate**: Categories ordered by highest leak rate first

#### Most Interacted Categories

- **Top Count Control**: Dropdown to show top 5, 10, 15, 20, 25, or 50 categories
- **Dynamic Display**: Shows "Showing top X of Y categories"
- **Sorted by Total Interactions**: Categories ordered by highest total interactions first
- **Affects Both Chart and Table**: Both visualizations use the same filtered data

#### Item-to-item Recommendations

- **Top Count Control**: Dropdown to show top 5, 10, 15, 20, 25, or 50 recommendations
- **Dynamic Display**: Shows "Showing top X of Y recommendations"
- **Per Anchor Item**: Count applies to recommendations for the selected anchor item

## Recent Updates

- **🔥 CONSOLIDATED ALL COMPONENTS**: Combined all analytics components into a single `AnalyticsDashboard.tsx` file for better maintainability
- **📊 GLOBAL DATE FILTERING ON ALL CHARTS**: Every graph, table, and metric now responds to the global date range filter
- **🎯 ENHANCED DATA RECALCULATION**: Cart leak analysis, category interactions, and summary statistics are recalculated based on filtered sessions
- **⚡ IMPROVED PERFORMANCE**: Single file architecture reduces import overhead and improves bundle size
- **🎨 BETTER UX**: Clear visual indicators showing which components are filtered by date range
- **🔄 SMART FILTERING**: Proportional scaling of analytics data based on session count in selected date range
- **🔧 FIXED DATA CONSISTENCY**: Resolved inconsistency between "Most Interacted Categories" and "Cart Leak by Category" by ensuring both components use the same cart add data from categoryInteractions
- **📈 INTERACTIVE DAILY TRENDS**: Added click functionality to Daily trends & anomaly flags chart to show detailed interaction data for selected days
- Fixed cart leak analysis to properly track by item ID instead of mixing categories and item IDs
- Improved category grouping to ensure all items are properly categorized
- Limited display to top 10 leaked categories for better focus
- Enhanced "Other" category handling for uncategorized items

### Data Consistency Fix (Latest)

**Issue**: The "Most Interacted Categories" and "Cart Leak by Category" components showed different cart add numbers for the same categories due to different data redistribution methods during date filtering.

**Root Cause**:

- Most Interacted Categories used category-level redistribution with `distributeToTotal()`
- Cart Leak by Category used item-level redistribution then regrouped by category
- This caused different totals for the same categories

**Solution**: Modified `CartLeakByCategory` component to use the same cart add data as `MostInteractedCategories` from `data.categoryInteractions`, while preserving the original leak calculation logic for removes. This ensures both components show consistent cart add numbers while maintaining accurate leak percentages.

## Interactive Daily Trends

### Overview

The Daily trends & anomaly flags chart now supports interactive exploration of day-specific data. Users can click on any data point to see detailed interaction data for that specific day.

### Features

#### Click Interaction

- **Clickable Data Points**: All data points on the daily trends chart are clickable
- **Visual Feedback**: Cursor changes to pointer when hovering over clickable points
- **Tooltip Enhancement**: Tooltips now include "Click to see details" hint

#### Day Detail View

When a day is selected, the system displays:

1. **Summary Statistics**:

   - Total sessions for the day
   - Total views for the day
   - Total cart adds for the day

2. **Category Breakdown**:

   - Top 10 most active categories for the selected day
   - Views, cart adds, and wishlist interactions per category
   - Most popular category highlighted with special styling

3. **Anomaly Detection**:
   - Visual indicator if the selected day is flagged as an anomaly
   - Explanation of anomaly detection for context

#### Data Processing

The day-specific data is calculated by:

1. **Session Filtering**: Filters all sessions to those occurring on the selected date
2. **Category Distribution**: Uses proportional distribution based on overall category popularity to estimate day-specific category interactions
3. **Interaction Estimation**: Distributes session-level interaction counts across categories based on their relative popularity
4. **Anomaly Checking**: Cross-references the selected date with detected anomaly outliers

### Implementation Details

#### Components

- **`DayInteractionDetails`**: New component that displays detailed interaction data for a selected day
- **Enhanced `DailyTrends`**: Modified to include click handling and state management for selected dates

#### State Management

- Uses React `useState` to track the currently selected date
- Automatically updates detail view when a new date is clicked
- Provides clear instructions when no date is selected

#### User Experience

- **Progressive Disclosure**: Details are hidden until a day is selected
- **Clear Instructions**: Helpful text guides users to click on data points
- **Responsive Design**: Detail view adapts to different screen sizes
- **Visual Hierarchy**: Most popular category is highlighted for quick identification

### Usage

1. Navigate to the "Daily trends & anomaly flags" section
2. Click on any data point in the line chart
3. View detailed interaction data below the chart
4. Click on different days to compare interaction patterns
5. Look for anomaly indicators to identify unusual activity days

This feature enables users to drill down from high-level trends to specific day analysis, helping identify what categories and actions drove traffic spikes or anomalies.
