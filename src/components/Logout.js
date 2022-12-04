import { getAuth, signOut } from "firebase/auth";
import React from "react";
import { app } from "../firebase";

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
