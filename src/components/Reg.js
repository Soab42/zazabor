import React from "react";

export default function Reg() {
  return (
    <div>
      <div className="text-center capitalize text-bold text-xl text-blue-300 ">
        Login form
      </div>
      <form className="grid h-64 w-96 text-blue-300">
        <label className="">
          <p className="pb-2 font-thin">Email</p>{" "}
          <input
            className=" bg-black opacity-50  h-10 w-full  shadow-md shadow-black outline-none pl-4
    "
            type={"email"}
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
          />
        </label>

        <button
          type="submit"
          className=" bg-black outline-none opacity-50   w-full  shadow-md shadow-black h-10 hover:opacity-90"
          onClick={(e) => e.preventDefault()}
        >
          Login
        </button>
      </form>
    </div>
  );
}
