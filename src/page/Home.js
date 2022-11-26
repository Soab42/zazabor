import React from "react";
import Card from "../components/Card";

import { productlist } from "../product/productname";

export default function Home() {
  return (
    <div className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 bg-blue-200">
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
