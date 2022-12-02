import React from "react";
import Card from "../components/Card";
import Carosel from "../components/Carosel";

import { productlist } from "../product/productname";

export default function Home() {
  return (
    <div className="">
      <div className="-z-10 overflow-hidden">
        <Carosel />
      </div>
      <div className="font-bold uppercase text-3xl mb-5 mt-5 flex">
        recent added product
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-5">
        {productlist.map((x, index) => (
          <Card
            name={x.name}
            price={x.price}
            discount={x.discount}
            image={x.image}
            index={index}
          />
        ))}
      </div>
    </div>
  );
}
