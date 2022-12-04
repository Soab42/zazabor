import React, { useState } from "react";
import { imagelist } from "../product/img";

export default function Carosel() {
  const [colors, setColors] = useState(0);
  // const prev = () => {
  //   setColors(colors < 1 ? imagelist.length - 1 : Number(colors - 1));
  // };
  // const next = () => {
  //   setColors(colors > imagelist.length - 2 ? 0 : Number(colors + 1));
  // };
  const change = () => {
    setColors(colors > imagelist.length - 2 ? 0 : colors + 1);
  };

  // setInterval(change, 4000);

  return (
    <div>
      <div className={"h-96 duration-700 overflow-hidden mb-2"}>
        <img
          className=" object-cover h-full w-full   duration-500 "
          src={`product/${imagelist[colors]}`}
          alt="card-img"
        />
      </div>
      <div className="hidden justify-between p-4 bg-green-300">
        <button
          className="bg-blue-200 p-1 hover:bg-pink-500 rounded-lg w-24"
          onClick={"prev"}
        >
          prev
        </button>
        <button
          className="bg-blue-200 p-1 hover:bg-pink-500 rounded-lg w-24"
          onClick={"next"}
        >
          Next
        </button>
      </div>
      <div>{Date}</div>
    </div>
  );
}
