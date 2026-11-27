/** Folder the user is currently browsing; new scans / documents are created in it. */
let currentFolderId: string | null = null;
export const getCurrentFolder = () => currentFolderId;
export const setCurrentFolder = (id: string | null) => (currentFolderId = id);
