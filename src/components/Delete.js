import { remove } from "firebase/database";
import React from "react";

export default function Logout() {
  return (
    <div
      className="flex gap-1"
      onClick={() => {
        const auth = getAuth(app);
        return signOut(auth);
      }}
    >
      Logout
    </div>
  );
}
