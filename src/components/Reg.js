import React, { useRef } from "react";
import {
  createUserWithEmailAndPassword,
  getAuth,
  updateProfile,
} from "firebase/auth";
import { app } from "../firebase";

export default function Reg() {
  const emailref = useRef();
  const passref = useRef();
  const userref = useRef();

  function onsubmit(e) {
    e.preventDefault();

    async function signup() {
      const auth = getAuth(app);
      await createUserWithEmailAndPassword(
        auth,
        emailref.current.value,
        passref.current.value
      );

      await updateProfile(auth.currentUser, {
        displayName: userref.current.value,
      });
    }
    signup();
    alert("sign up succes");
  }

  return (
    <div className="grid justify-center">
      <div className="text-center capitalize text-bold text-xl text-blue-300">
        Registration form
      </div>
      <form className="grid h-96 w-96 text-blue-300" onSubmit={onsubmit}>
        <label className="">
          <p className="pb-2 font-thin">Email</p>{" "}
          <input
            className=" bg-black opacity-50  h-10 w-full  shadow-md shadow-black outline-none pl-4
    "
            type={"email"}
            ref={emailref}
            required
          />
        </label>

        <label>
          <p className="pb-2 font-thin">Password</p>
          <input
            className=" bg-black outline-none opacity-50  h-10 w-full  shadow-md shadow-black pl-4
    "
            required
            type={"password"}
            ref={passref}
          />
        </label>
        <label>
          <p className="pb-2 font-thin">user name</p>
          <input
            className=" bg-black outline-none opacity-50  h-10 w-full  shadow-md shadow-black pl-4
    "
            required
            type={"text"}
            ref={userref}
          />
        </label>

        <button
          type="submit"
          className=" bg-black outline-none opacity-50   w-full  shadow-md shadow-black h-10 hover:opacity-90"
        >
          Login
        </button>
      </form>
      <div></div>
    </div>
  );
}
