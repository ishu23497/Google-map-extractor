# Google Maps Business Data Extractor

A Node.js script to extract business listings from Google Maps using Puppeteer.

## Features
- Automated Google Maps search and extraction.
- Extracts: Name, Address, Phone, Website, Rating, Review Count, Category.
- Auto-scrolls to load multiple results.
- Exports data to CSV.
- Configurable Keyword, Location, and Max Results.

## Prerequisites
- Node.js installed.

## Installation

1. Clone or download this project.
2. Install dependencies:
   ```sh
   npm install
   ```

## Usage

1. Open `index.js` to modify the configuration at the top of the file if needed (KEYWORD, LOCATION, MAX_RESULTS).
2. Run the script:
   ```sh
   node index.js
   ```
3. The browser will open, perform the search, and scrape the data.
4. Once finished, a `google_maps_data.csv` file will be created in the project directory.

## Configuration

In `index.js`:
```javascript
const CONFIG = {
    keyword: 'Web Development Company', // Search keyword
    location: 'Agra, India',            // Location
    maxResults: 100,                    // Number of results to scrape
    headless: false,                    // Set to true to hide the browser window
    outputFile: 'google_maps_data.csv'  // Output file name
};
```

## Disclaimer
This tool is for educational purposes only. Automated scraping of Google Maps may violate their Terms of Service. Use responsibly.
