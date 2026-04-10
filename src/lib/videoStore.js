const DB_NAME = 'sendspark-video-tool';
const DB_VERSION = 1;
const STORE_NAME = 'videos';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error('Failed to open local video database.'));

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
  });
}

function txRequestToPromise(request, fallbackMessage) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(fallbackMessage));
  });
}

function withStore(mode, callback) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);

        let callbackResult;
        try {
          callbackResult = callback(store);
        } catch (error) {
          reject(error);
          return;
        }

        transaction.oncomplete = () => {
          db.close();
          resolve(callbackResult);
        };

        transaction.onerror = () => {
          db.close();
          reject(new Error('Video database transaction failed.'));
        };
      }),
  );
}

export async function addVideoRecord(record) {
  const payload = {
    ...record,
    id: record.id || crypto.randomUUID(),
    createdAt: record.createdAt || new Date().toISOString(),
  };

  await withStore('readwrite', (store) => {
    store.put(payload);
  });

  return payload;
}

export async function listVideoRecords() {
  const records = await withStore('readonly', (store) =>
    txRequestToPromise(store.getAll(), 'Unable to load saved videos.'),
  );

  if (!records) {
    return [];
  }

  return records
    .map((record) => ({
      ...record,
      previewUrl: URL.createObjectURL(record.blob),
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getVideoRecord(id) {
  return withStore('readonly', (store) =>
    txRequestToPromise(store.get(id), 'Unable to load selected video.'),
  );
}

export async function deleteVideoRecord(id) {
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
}

export function revokeVideoUrls(records) {
  records.forEach((record) => {
    if (record.previewUrl) {
      URL.revokeObjectURL(record.previewUrl);
    }
  });
}
