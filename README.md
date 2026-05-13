# Filecoin Auto-Split Smart Uploader (v4)

A complete, production-ready Node.js & Express web application that seamlessly uploads, packs, splits, and pins files to the Filecoin network using the Synapse SDK and the Filecoin Onchain Cloud (FOC). 

This tool abstracts away the complexities of interacting with the Filecoin blockchain, providing a beautiful, single-page frontend UI to manage your datasets.

## ✨ Features (v4)

* **Auto-Packing & Splitting:** Automatically packs files/folders into IPFS `.car` files. If a `.car` exceeds the 1 GiB limit, it intelligently splits it into smaller chunks using `carbites` via a tree-walk before uploading.
* **Direct On-Chain Uploads:** Uses `@filoz/synapse-sdk` to upload chunks directly to Filecoin Datasets.
* **Live SSE Progress Tracking:** Real-time UI progress bars for local uploading, `.car` packing, splitting, and Filecoin network transmission.
* **Smart History Table:** 
  * Fetches dataset history via the `filecoin-pin` CLI.
  * Intelligently groups split chunks (Piece CIDs) under their parent file (`Root CID`).
  * Fully supports legacy, unnamed uploads.
* **Optimized UI:**
  * Clean, single-line truncated CIDs (`bafkzcib...a4f2`) with native hover-to-view functionality.
  * 📋 **1-Click Copy** buttons for all Root and Piece CIDs.
  * 🗑️ **Grouped Deletion:** Remove an entire file (and all its related split chunks) from your dataset with a single click.
  * 💳 **Payment Status:** Check your current storage payment balances directly from the UI.
* **Secure Backend:** Your Filecoin private key never touches the browser. All blockchain transactions and signatures are handled securely by the Node.js server.

---

## 📋 Prerequisites

Before running this application, ensure you have the following installed:

1. **Node.js**: v18.0.0 or higher (required for modern `fetch`, `streams`, and ES Modules).
2. **Filecoin Wallet**: A Filecoin private key loaded with FIL for gas fees and storage payments.
3. **Dataset ID**: An active Filecoin Onchain Cloud Dataset ID (created via the Synapse dApp or CLI).

---

## 🚀 Installation & Setup

**1. Clone the repository and navigate into the directory:**
```bash
git clone https://github.com/your-username/filecoin-smart-uploader.git
cd filecoin-smart-uploader
```

**2. Initialize the project and install dependencies:**
Because this project uses ES Modules (`import`), ensure your `package.json` has `"type": "module"`. 
```bash
npm init -y
npm pkg set type="module"
```

**3. Install required NPM packages:**
```bash
# Install server and Filecoin SDK dependencies
npm install express multer viem @filoz/synapse-sdk @filoz/synapse-core

# Install CLI tools used locally by the app
npm install ipfs-car carbites filecoin-pin
```

**4. Configure the Application:**
Open `server_1.mjs` in your code editor and update the configuration variables at the top of the file:

```javascript
// Configure your Filecoin wallet & Dataset
const PRIVATE_KEY = '0x_YOUR_PRIVATE_KEY_HERE'; // Add your hex private key
const DATASET_ID = 99;                          // Replace with your target Dataset ID
const RPC_URL = 'https://api.node.glif.io/rpc/v1'; // Default GLIF node
```

---

## 💻 Usage

Start the server:
```bash
node server_1.mjs
```

Open your web browser and navigate to:
**`http://localhost:3000`**

### Available Actions in the UI:
1. **Process & Upload File:** Select a single file or a deeply nested folder. The app will stream it to the backend, pack it, split it if it exceeds 1 GiB, and pin the chunks to your dataset.
2. **View Upload History:** Queries the blockchain for your active Dataset storage. Groups files by Root CID and allows you to copy CIDs or Delete files.
3. **Check Payments Status:** Connects to the RPC and returns your current storage balances and network account status.

---

## 🏗️ Architecture / How it Works

1. **Frontend to Backend (`multer`):** Files are uploaded from the browser to the local Node.js `uploads/` directory.
2. **IPFS Packing (`ipfs-car`):** The local files are bundled into a cryptographic `.car` archive. A Root CID is generated.
3. **Chunking (`carbites`):** If the `.car` exceeds the max Filecoin sector size (~1 GiB), `carbites` splits the file into standard chunks while preserving the IPFS DAG.
4. **Blockchain Pinning (`Synapse SDK`):** The backend establishes a connection to the Filecoin mainnet via `viem` and streams the `.car` chunks into the specified Dataset.
5. **CLI Wrapping (`filecoin-pin`):** Complex dataset management (deleting pieces, querying history, and checking payments) is handled by securely executing `filecoin-pin` terminal commands directly from the Node.js backend.

---

## ⚠️ Important Notes
* **File Deletion:** Filecoin transactions take time to confirm. When you delete a file, the UI will freeze the delete button and wait for blockchain confirmation before refreshing the table. This prevents transaction nonce collisions.
* **Storage Limits:** The local server allows up to `5GB` payloads per web upload request via `multer`. Ensure the machine running this Node server has enough local disk space in the `./uploads` directory to handle temporary `.car` generation.
* **Cache Busting:** v4 includes aggressive cache-busting headers. You will always see the latest UI without needing to hard-refresh your browser.

## 📄 License
MIT
