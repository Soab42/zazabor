import React from "react";
import { useParams } from "react-router-dom";
import "../product/productname";
import classes from "../styles/Product.module.css";
import "../styles/product.css";
export default function Product() {
  const { productname } = useParams();

  return (
    <main className={classes.main}>
      <header>{productname}</header>
      <upper className={classes.upper}>
        <left className={classes.left}>
          left
          <div>
            <img
              className="object-cover h-32 w-80 rounded-md"
              src={""}
              alt="card-img"
            />
            <div className="card">hello</div>
          </div>
        </left>
        <right className={classes.right}>
          <details className={classes.details}>details of a product</details>
          <card className={classes.card}>card</card>
        </right>
      </upper>
      <middle className={classes.middle}>middle</middle>
      <bottom className={classes.bottom}>bottom</bottom>
    </main>
  );
}
