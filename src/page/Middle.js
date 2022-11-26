import React from "react";
import { NavHashLink } from "react-router-hash-link";

export default function Middle() {
  return (
    <div className="flex">
      <div className="grid w-2/3">
        <nav className="bg-white flex p-2 justify-around">
          <NavHashLink
            className={
              "ring-2 p-1 ring-red-500 w-1/4 hover:bg-orange-600 hover:text-yellow-50 duration-500"
            }
            to="#spacification"
          >
            spacification
          </NavHashLink>
          <NavHashLink
            className={
              "ring-2 p-1 ring-red-500 w-1/4 hover:bg-orange-600 hover:text-yellow-50 duration-500"
            }
            to="#description"
          >
            description
          </NavHashLink>
          <NavHashLink
            className={
              "ring-2 p-1 ring-red-500 w-1/4 hover:bg-orange-600 hover:text-yellow-50 duration-500"
            }
            to="#quistion"
          >
            quistion
          </NavHashLink>
          <NavHashLink
            className={
              "ring-2 p-1 ring-red-500 w-1/4 hover:bg-orange-600 hover:text-yellow-50 duration-500"
            }
            to="#reviews"
          >
            reviews
          </NavHashLink>
        </nav>
        <spacificaion
          className=" h-screen bg-red-200 text-white"
          id="specification"
        >
          specification
        </spacificaion>
        <description
          className=" h-screen bg-red-300 text-white"
          id="description"
        >
          description
        </description>
        <quistion id="quistion" className=" h-screen bg-red-400 text-white">
          quistion
        </quistion>
        <review id="reviews" className=" h-screen bg-red-500 text-white">
          review
        </review>
      </div>
      <div>similar products</div>
    </div>
  );
}
