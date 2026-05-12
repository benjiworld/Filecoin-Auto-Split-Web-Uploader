# Filecoin Auto-Split Web Uploader 🚀

A modern, "all-in-one" Node.js web application for directly uploading massive files and entire directory structures (>1GB) to the Filecoin network. 

Built using the `@filoz/synapse-sdk`, this tool entirely bypasses the need to run a local IPFS/Kubo daemon. It automatically handles IPLD packing (`ipfs-car`), chunk splitting (`carbites`), and sequential Filecoin smart-contract deal negotiations behind the scenes, providing real-time UI progress bars via Server-Sent Events (SSE).

## ✨ Features
- **No IPFS Node Required:** Uploads straight to Filecoin Storage Providers via the Synapse SDK.
- **Folder & Huge File Support:** Select massive single files or deep directory trees right in the browser.
- **Auto-Chunking:** Automatically splits files larger than 1GB into manageable `.car` chunks using `carbites`.
- **Live Progress UI:** Real-time web progress bars for server upload, packing, splitting, and Filecoin network transmission.
- **Root CID & Metadata:** Automatically extracts the IPFS Root CID and attaches it (along with file size and names) to the Filecoin Piece metadata for easy CLI tracking.
- **Automatic Cleanup:** Safely deletes temporary `.car` chunks from the server disk after successful blockchain transmission to prevent storage bloat.

## 📦 Prerequisites

Ensure you have **Node.js (v18+)** and **npm** installed on your server or local machine. You will also need a Filecoin wallet funded with Mainnet FIL.

## 🛠 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/filecoin-auto-split-uploader.git
   cd filecoin-auto-split-uploader
   ```

2. **Initialize the project & install core dependencies:**
   ```bash
   npm init -y
   npm install express multer viem @filoz/synapse-sdk @filoz/synapse-core
   ```

3. **Install the CLI tools required for backend processing:**
   ```bash
   npm install ipfs-car carbites
   ```

4. **Set Project Type to Module:**
   Ensure your `package.json` includes `"type": "module"` so Node.js correctly parses the modern ES Module syntax used in the SDK.
   ```json
   {
     "name": "filecoin-auto-split-uploader",
     "version": "1.0.0",
     "type": "module",
     "main": "server.mjs",
     "dependencies": { ... }
   }
   ```

## ⚙️ Configuration

Open `server.mjs` and configure your environment variables at the top of the file:

```javascript
// Add your Filecoin wallet Private Key (Must be funded with FIL!)
const PRIVATE_KEY = '0x_YOUR_PRIVATE_KEY_HERE';

// Set your desired Filecoin Dataset ID for tracking via the filecoin-pin CLI
const DATASET_ID = 99; 
```
*(Note: For production environments, it is highly recommended to move `PRIVATE_KEY` into a `.env` file using the `dotenv` package.)*

## 🚀 Usage

1. **Start the server:**
   ```bash
   node server.mjs
   ```

2. **Access the Web UI:**
   Open your browser and navigate to:  
   👉 `http://localhost:3000`

3. **Upload Data:**
   - Select either **Single File** or **Folder Directory**.
   - Choose your data and click **Process & Upload**.
   - Watch the live progress bars as your server packs the DAG, splits the files (if >1GB), and negotiates the storage deals on the Filecoin Mainnet.

## 🔍 Verifying Uploads

Because this tool attaches metadata and routes uploads to a specific Dataset, you can easily verify your uploads using the official Filecoin-Pin CLI.

1. Ensure you have the CLI installed: `npm install -g filecoin-pin`
2. Run the dataset show command:
   ```bash
   filecoin-pin dataset show 99 --rpc-url https://api.node.glif.io/rpc/v1
   ```

**Example Output:**
```text
#80 (active)
│        PieceCID: bafkzcibe2ocxoepiizirubqapz7i5at3day43mnkdb573lhvlm27ty4tm6r47e7mdi
│        Size: 2.1 MiB
│        Metadata
│          name: "Datasheet.pdf.car"
│          original_file: "Datasheet.pdf"
│          root_cid: "bafyreicnlu2nkyskaswvercbvwbkuwhp6axshd7ngfvhtz..."
│          size_bytes: "2211117"
```

## 🏗 Architecture & Flow
1. **Multer (DiskStorage):** The browser streams the raw file/folder to the Node.js server.
2. **ipfs-car:** The server executes `npx ipfs-car` to wrap the raw data into an IPLD Directed Acyclic Graph (DAG) and generates the master `.car` file.
3. **carbites:** If the `.car` exceeds 1GB, the server executes `npx carbites` to cleanly slice the DAG into Filecoin-compliant chunks.
4. **Synapse SDK:** The server bypasses the SDK's internal packager (`isCar: true`) and streams the chunks directly to Filecoin Storage Providers, paying gas fees via `viem`.

## 📄 License
MIT License
