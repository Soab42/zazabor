import { getAuth } from "firebase/auth";
import React from "react";
import { Navigate } from "react-router-dom";
import { app } from "../firebase";

export default function Private({ children }) {
  const { currentUser } = getAuth(app);
  console.log(currentUser);

  return currentUser !== null ? children : <Navigate to={"/"} />;
}
