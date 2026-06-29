let store = {};

export const getFirestore = jest.fn(() => ({}));

export const doc = (db, ...pathSegments) => pathSegments.join('/');

export const getDoc = async (key) => ({
  exists: () => key in store,
  data: () => store[key],
});

export const setDoc = async (key, data) => {
  store[key] = data;
};

export const runTransaction = async (db, updateFunction) => {
  const transaction = {
    get: async (key) => ({
      exists: () => key in store,
      data: () => store[key],
    }),
    set: (key, data) => {
      store[key] = data;
    },
  };
  return updateFunction(transaction);
};

export const __resetFirestoreMock = () => {
  store = {};
};
