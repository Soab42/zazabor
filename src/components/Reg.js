import React, { useRef } from "react";

export default function Reg() {
  const email = useRef();
  const pass = useRef();
  const user = useRef();
  function onsubmit(e) {
    e.preventDefault();
    console.log(email.current.value);
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
            ref={email}
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
            ref={pass}
          />
        </label>
        <label>
          <p className="pb-2 font-thin">user name</p>
          <input
            className=" bg-black outline-none opacity-50  h-10 w-full  shadow-md shadow-black pl-4
    "
            required
            type={"text"}
            ref={user}
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
